// Dedicated batch module for /retitle-auto-sessions.
// Manages batch auto retitling across all open root session tabs with bounded concurrency 2,
// snapshot immutability, gate reservation, fail-closed verification, and failure containment.

import type { RetitleAdapter } from "./adapter"
import {
  snapshotTabCandidates,
  verifyCapturedSession,
  type BatchSessionData,
} from "./batch-scope"
import {
  type RetitleAutoResult,
  type RetitleUiContext,
  executeRetitleAutoWithGrant,
} from "./dialogs"
import type { GateGrant } from "./gate"
import { settingsFromArgs } from "./settings"

export interface BatchProgress {
  readonly updated: number
  readonly skipped: number
  readonly failed: number
  readonly completed: number
  readonly total: number
  readonly active: number
  readonly text: string
}

export interface BatchSummary {
  readonly status: "completed" | "skipped"
  readonly reason?: "already-running" | "no-tabs"
  readonly updated: number
  readonly skipped: number
  readonly failed: number
  readonly total: number
}

export interface BatchOptions {
  readonly onProgress?: (progress: BatchProgress) => void
  readonly onPendingChange?: (delta: 1 | -1) => void
  readonly concurrency?: number
}

const DEFAULT_CONCURRENCY = 2
const NO_TABS_MESSAGE = "Session tabs not available or empty"

/** Global/Adapter-level active batch state protection */
const activeBatchesByAdapter = new WeakSet<RetitleAdapter>()

export class BatchController {
  constructor(
    private readonly context: RetitleUiContext,
    private readonly adapter: RetitleAdapter,
    private readonly data?: BatchSessionData | unknown,
  ) {}

  async run(rawArgs: string, options?: BatchOptions): Promise<BatchSummary> {
    if (activeBatchesByAdapter.has(this.adapter)) {
      safeEvent(this.adapter, "batch-rejected", { reason: "already-running" })
      showDirectToast(this.context, "warning", "Batch retitle already running")
      return { status: "skipped", reason: "already-running", updated: 0, skipped: 0, failed: 0, total: 0 }
    }

    const scope = snapshotTabCandidates(this.context)
    if (scope.status === "no-tabs") {
      safeEvent(this.adapter, "batch-no-tabs", { reason: "tabs-disabled-or-empty" })
      showDirectToast(this.context, "warning", NO_TABS_MESSAGE)
      return { status: "skipped", reason: "no-tabs", updated: 0, skipped: 0, failed: 0, total: 0 }
    }

    const candidateIDs = scope.candidateIDs
    const total = candidateIDs.length
    const claimedGrants = new Map<string, GateGrant>()
    let preclaimSkippedCount = 0
    let pendingReported = false

    const notifyPending = (delta: 1 | -1) => {
      try {
        options?.onPendingChange?.(delta)
      } catch {
        // Observers must not interrupt the run or its cleanup
      }
    }

    // Adapter-level active batch guard claimed BEFORE any await
    activeBatchesByAdapter.add(this.adapter)

    try {
      const baseSettings = settingsFromArgs(this.adapter.settings.read(), rawArgs)
      // Synchronously reserve gate for all captured IDs before any async tick
      for (const sessionID of candidateIDs) {
        const grant = this.adapter.gate.begin(sessionID, { interactive: false })
        if (grant.ok) {
          claimedGrants.set(sessionID, grant)
        } else {
          preclaimSkippedCount++
          safeEvent(this.adapter, "batch-session-skipped", { sessionID, reason: grant.reason })
        }
      }

      const preclaimedIDs = Array.from(claimedGrants.keys())
      if (preclaimedIDs.length === 0) {
        const summary: BatchSummary = {
          status: "completed",
          updated: 0,
          skipped: preclaimSkippedCount,
          failed: 0,
          total,
        }
        showDirectToast(
          this.context,
          "warning",
          `Batch retitle: 0 updated, ${preclaimSkippedCount} skipped, 0 failed (${total} total)`,
        )
        return summary
      }

      notifyPending(1)
      pendingReported = true

      let updated = 0
      let skipped = preclaimSkippedCount
      let failed = 0
      let completed = preclaimSkippedCount
      let activeWorkers = 0
      let unverified = 0

      const emitProgress = () => {
        const text = `retitle-auto-sessions: ${completed}/${total} (${updated} updated, ${skipped} skipped, ${failed} failed)`
        try {
          options?.onProgress?.({
            updated,
            skipped,
            failed,
            completed,
            total,
            active: activeWorkers,
            text,
          })
        } catch {
          // Observers must not interrupt the run
        }
      }

      emitProgress()

      // Async fail-closed metadata verification (max concurrency 2)
      const verifiedIDs = new Set<string>()
      let metaIndex = 0
      const metaWorker = async () => {
        while (metaIndex < preclaimedIDs.length) {
          const id = preclaimedIDs[metaIndex++]
          const grant = claimedGrants.get(id)
          if (!grant) continue

          const verification = await verifyCapturedSession(id, this.context, this.adapter, this.data)
          if (verification.verified) {
            verifiedIDs.add(id)
          } else {
            // Unverified, child or helper session: release gate early and mark as skipped
            try {
              this.adapter.gate.end(grant.token)
            } catch {
              // ignore
            }
            claimedGrants.delete(id)
            skipped++
            completed++
            if (verification.reason === "unverified") unverified++
            safeEvent(this.adapter, "batch-session-skipped", { sessionID: id, reason: verification.reason })
            emitProgress()
          }
        }
      }

    const metaWorkers: Promise<void>[] = []
    for (let i = 0; i < Math.min(DEFAULT_CONCURRENCY, preclaimedIDs.length); i++) {
      metaWorkers.push(metaWorker())
    }
    await Promise.allSettled(metaWorkers)
    const validIDs = preclaimedIDs.filter((id) => verifiedIDs.has(id))

    if (validIDs.length === 0) {
      const summary: BatchSummary = {
        status: "completed",
        updated: 0,
        skipped,
        failed: 0,
        total,
      }
      showDirectToast(
        this.context,
        "warning",
        `Batch retitle: 0 updated, ${skipped} skipped, 0 failed (${total} total)${unverified ? `; ${unverified} unverified metadata` : ""}`,
      )
      return summary
    }

      const requestedConcurrency = options?.concurrency
      const concurrency =
        typeof requestedConcurrency === "number" && Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
          ? Math.min(requestedConcurrency, DEFAULT_CONCURRENCY)
          : DEFAULT_CONCURRENCY
      let nextIndex = 0

      const worker = async () => {
        while (nextIndex < validIDs.length) {
          const currentIndex = nextIndex++
          const sessionID = validIDs[currentIndex]
          const grant = claimedGrants.get(sessionID)!

          activeWorkers++
          emitProgress()

          try {
            const workerSettings = { ...baseSettings }
            const result: RetitleAutoResult = await executeRetitleAutoWithGrant(
              this.context,
              this.adapter,
              sessionID,
              workerSettings,
              grant,
            )

            if (result.status === "updated") {
              updated++
            } else if (result.status === "skipped") {
              skipped++
            } else {
              failed++
            }
          } catch (error) {
            failed++
            try {
              this.adapter.logger.event("batch-worker-error", { sessionID, error })
            } catch {
              // Contain logger errors to protect sibling workers
            }
          } finally {
            activeWorkers--
            completed++
            emitProgress()
          }
        }
      }

      const workers: Promise<void>[] = []
      const workerCount = Math.min(concurrency, validIDs.length)
      for (let i = 0; i < workerCount; i++) {
        workers.push(worker())
      }

      await Promise.allSettled(workers)

      const summaryToast = `Batch retitle: ${updated} updated, ${skipped} skipped, ${failed} failed (${total} total)${unverified ? `; ${unverified} unverified metadata` : ""}`
      showDirectToast(
        this.context,
        failed > 0 ? "warning" : "success",
        summaryToast,
      )

      return {
        status: "completed",
        updated,
        skipped,
        failed,
        total,
      }
    } finally {
      // Release every remaining claimed grant unconditionally on exit path (idempotent)
      for (const grant of claimedGrants.values()) {
        try {
          this.adapter.gate.end(grant.token)
        } catch {
          // ignore cleanup error
        }
      }
      claimedGrants.clear()

      activeBatchesByAdapter.delete(this.adapter)
      if (pendingReported) {
        notifyPending(-1)
      }
    }
  }
}

function safeEvent(adapter: RetitleAdapter, name: string, fields: Record<string, unknown>): void {
  try { adapter.logger.event(name, fields) } catch { /* Logging is not part of batch ownership. */ }
}

function showDirectToast(context: RetitleUiContext, variant: "warning" | "success" | "error", message: string): void {
  try {
    context.ui.toast.show({ variant, title: "Retitle", message, duration: 6000 })
  } catch {
    // Ignore toast display errors
  }
}

export function createBatchController(
  context: RetitleUiContext,
  adapter: RetitleAdapter,
  data?: BatchSessionData | unknown,
): BatchController {
  return new BatchController(context, adapter, data)
}

export async function openRetitleAutoSessions(
  context: RetitleUiContext,
  adapter: RetitleAdapter,
  rawArgs: string,
  options?: BatchOptions,
  data?: BatchSessionData | unknown,
): Promise<BatchSummary> {
  const controller = createBatchController(context, adapter, data)
  return controller.run(rawArgs, options)
}
