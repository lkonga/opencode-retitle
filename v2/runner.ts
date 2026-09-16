// /retitle orchestration: sampling -> model -> native generation -> title.
//
// The runner is a pure pipeline over injected ports. It never touches the TUI,
// the filesystem, or the network directly, so the behavioural cases the issue
// calls out — empty history, a single short turn, a long session, provider
// failure, a hard timeout, and a title write — are all exercised against fakes.

import {
  cleanTitle,
  normalizeGeneratedText,
  parseRetitleArgs,
  sampleTurns,
  settingsToArgs,
  titlePrompt,
  type ModelRef,
  type RetitleMessage,
  type RetitleSettings,
} from "./retitle-core"
import { describeRetitleError, type RetitleErrorCode } from "./errors"
import { RetitleTimeoutError } from "./deadline"
import type { RetitleLogger } from "./logger"

export type RetitleOutcome =
  | { readonly status: "ok"; readonly title: string; readonly model: ModelRef }
  | { readonly status: "empty"; readonly messageCount: number }
  | { readonly status: "no-title"; readonly model: ModelRef }
  | { readonly status: "error"; readonly code: RetitleErrorCode; readonly message: string }

export interface RetitlePorts {
  /** Bounded, normalized session history (newest page only). */
  loadMessages(sessionID: string): Promise<RetitleMessage[]>
  /** Resolves and validates the generation model; throws RetitleError("model"). */
  resolveModel(sessionID: string, messages: ReadonlyArray<RetitleMessage>, override: string): Promise<ModelRef>
  /** Native generation; resolves to bounded assistant text or undefined. */
  generateTitle(input: { readonly sessionID: string; readonly prompt: string; readonly model: ModelRef }): Promise<string | undefined>
  /** Public rename. */
  applyTitle(sessionID: string, title: string): Promise<void>
}

export interface RetitleRunInput {
  readonly sessionID: string
  readonly settings: RetitleSettings
  readonly logger?: RetitleLogger
}

/**
 * Runs one retitle up to (but not including) the title write. The confirm,
 * edit and apply steps belong to the dialog lifecycle; this function only
 * produces the candidate title so a failure can never half-apply.
 */
export async function executeRetitle(ports: RetitlePorts, input: RetitleRunInput): Promise<RetitleOutcome> {
  const { logger } = input
  const { steeringHint, samplingOptions } = parseRetitleArgs(settingsToArgs(input.settings))
  logger?.event("run-start", {
    sessionID: input.sessionID,
    hasOverride: Boolean(input.settings.model),
    hasHint: Boolean(steeringHint),
  })

  try {
    const messages = await ports.loadMessages(input.sessionID)
    const sampled = sampleTurns(messages, samplingOptions)
    logger?.event("sampled", {
      sessionID: input.sessionID,
      messageCount: messages.length,
      sampledCount: sampled.length,
      maxSamples: samplingOptions?.maxSamples ?? null,
      fromPercent: samplingOptions?.fromPercent ?? null,
      offset: samplingOptions?.offset ?? null,
    })
    if (sampled.length === 0) return { status: "empty", messageCount: messages.length }

    const model = await ports.resolveModel(input.sessionID, messages, input.settings.model)
    // The model's provenance is logged by the adapter that resolved it
    // (`model-selected`: model ids, chain step, stale-preference count) — all
    // metadata, never the prompt or the transcript.

    const raw = await ports.generateTitle({
      sessionID: input.sessionID,
      prompt: titlePrompt(sampled, steeringHint),
      model,
    })
    const title = cleanTitle(normalizeGeneratedText(raw) ?? "")
    if (!title) {
      logger?.event("no-title", { sessionID: input.sessionID })
      return { status: "no-title", model }
    }
    logger?.event("title-ready", { sessionID: input.sessionID, titleLength: title.length })
    return { status: "ok", title, model }
  } catch (error) {
    const described = describeRetitleError(error)
    if (error instanceof RetitleTimeoutError) {
      logger?.event("run-timeout", { sessionID: input.sessionID, stage: error.stage, deadlineMs: error.deadlineMs })
      return { status: "error", code: "deadline", message: `Title generation timed out after ${error.deadlineMs}ms` }
    }
    logger?.event("run-error", { sessionID: input.sessionID, code: described.code, error })
    return { status: "error", code: described.code, message: described.message }
  }
}

/** Applies a confirmed title, mapping failures to a redaction-safe outcome. */
export async function applyRetitleTitle(
  ports: Pick<RetitlePorts, "applyTitle">,
  sessionID: string,
  title: string,
  logger?: RetitleLogger,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: RetitleErrorCode; readonly message: string }> {
  try {
    await ports.applyTitle(sessionID, title)
    logger?.event("title-applied", { sessionID, titleLength: title.length })
    return { ok: true }
  } catch (error) {
    const described = describeRetitleError(error, "rename")
    logger?.event("title-apply-error", { sessionID, code: described.code, error })
    return { ok: false, code: described.code, message: described.message }
  }
}
