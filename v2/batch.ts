// Dedicated batch module for /retitle-auto-sessions.
// Manages batch auto retitling across all open root session tabs with bounded concurrency 2,
// snapshot immutability, gate reservation, and failure containment.

import type { RetitleAdapter } from "./adapter"
import { snapshotTabCandidates, type BatchSessionData } from "./batch-scope"
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
      this.adapter.logger.event("batch-rejected", { reason: "already-running" })
      return { status: "skipped", reason: "already-running", updated: 0, skipped: 0, failed: 0, total: 0 }
    }

    const scope = snapshotTabCandidates(this.context, this.data)
    if (scope.status === "no-tabs") {
      this.adapter.logger.event("batch-no-tabs", { reason: "tabs-disabled-or-empty" })
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

    activeBatchesByAdapter.add(this.adapter)

    try {
      // Reserve all valid captured IDs synchronously via SAME adapter.gate before first await
      for (const sessionID of candidateIDs) {
        const grant = this.adapter.gate.begin(sessionID, { interactive: false })
        if (grant.ok) {
          claimedGrants.set(sessionID, grant)
        } else {
          preclaimSkippedCount++
          this.adapter.logger.event("batch-session-skipped", { sessionID, reason: grant.reason })
        }
      }

      const validIDs = Array.from(claimedGrants.keys())
      if (validIDs.length === 0) {
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

      // Snapshot settings once
      const baseSettings = settingsFromArgs(this.adapter.settings.read(), rawArgs)
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
            this.adapter.logger.event("batch-worker-error", { sessionID, error })
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

      await Promise.all(workers)

      const summaryToast = `Batch retitle: ${updated} updated, ${skipped} skipped, ${failed} failed (${total} total)`
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
      // Release every claimed grant unconditionally on exit path (idempotent)
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
