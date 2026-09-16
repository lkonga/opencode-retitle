// Public OpenCode V2 session API adapter for /retitle.
//
// Everything here is expressed as public client-method calls. No wire path,
// verb, or envelope is constructed by this plugin; the generated client owns
// that. Two revisions of the runtime are known to be in play — the pinned
// public source and the installed `v2.0.3-dev-patched` binary (see
// NATIVE-AUDIT.md) — and they differ underneath (`session.rename` is
// `POST /api/session/:id/rename` in the source and
// `PATCH /api/session/:id` in the installed binary), which is exactly why the
// plugin must not hand-roll requests.
//
// Boundaries enforced here:
//   * history reads are bounded to one page, newest-first, never cursor-walked;
//   * every request has a hard deadline and an AbortSignal;
//   * the generation helper session is removed in `finally`, on a separate
//     deadline, including when generation times out or fails;
//   * results are normalized tolerantly (`normalizeGeneratedText`,
//     `normalizeMessagePage`, `normalizeCreatedSessionID`).

import {
  normalizeCreatedSessionID,
  normalizeGeneratedText,
  normalizeMessagePage,
  normalizeMessages,
  MAX_GENERATED_TEXT_LENGTH,
  type RawSessionMessage,
  type RetitleMessage,
} from "./retitle-core"
import { createDeadline, withDeadline, RetitleTimeoutError } from "./deadline"
import { RetitleError } from "./errors"
import type { RetitleLogger } from "./logger"

/** Title generation is the one long request; 45s covers slow providers. */
export const DEFAULT_GENERATE_TIMEOUT_MS = 45_000
/** Helpers must be created quickly; a slow create means the server is unwell. */
export const DEFAULT_HELPER_TIMEOUT_MS = 15_000
/** Cleanup is best-effort but must never hang the finally path. */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000
/** Title writes are small; a slow one means the server is unwell. */
export const DEFAULT_RENAME_TIMEOUT_MS = 10_000
/** Bounded history reads are one small page. */
export const DEFAULT_HISTORY_TIMEOUT_MS = 10_000

/**
 * Bounded history: the single page is the whole window retitle ever sees, so a
 * 10k-message session cannot turn into a 10k-message prompt. The pinned source
 * caps `limit` at 200 (`packages/protocol/src/groups/message.ts:11`); the
 * installed schema declares no cap, and retitle still reads exactly one page
 * and never follows `cursor.next`.
 */
export const MESSAGE_PAGE_LIMIT = 200

export const TITLE_AGENT = "title"
export const HELPER_TITLE = "Retitle generation"

export type RequestOptionsLike = { readonly signal?: AbortSignal }
export type LocationLike = { readonly directory: string; readonly workspaceID?: string }
export type ModelRefLike = { readonly id: string; readonly providerID: string; readonly variant?: string }

/** Structural projection of `context.client` (see the module header). */
export interface SessionApiClient {
  readonly session: {
    create?(input: Record<string, unknown>, options?: RequestOptionsLike): Promise<unknown>
    generate?(input: { sessionID: string; prompt: string }, options?: RequestOptionsLike): Promise<unknown>
    remove?(input: { sessionID: string }, options?: RequestOptionsLike): Promise<unknown>
    rename?(input: { sessionID: string; title: string }, options?: RequestOptionsLike): Promise<unknown>
  }
  readonly message: {
    list?(
      input: { sessionID: string; limit?: number; order?: "asc" | "desc" },
      options?: RequestOptionsLike,
    ): Promise<unknown>
  }
}

export function supportsNativeGeneration(client: SessionApiClient): boolean {
  return typeof client.session?.generate === "function"
}

/**
 * Reads one bounded page of projected session messages. The page is requested
 * newest-first and reversed locally so sampling keeps V1's oldest-to-newest
 * ordering. A read failure is logged and surfaced as an empty history rather
 * than a thrown error: "no turns to sample" is the correct user-facing outcome.
 */
export async function loadSessionMessages(
  client: SessionApiClient,
  sessionID: string,
  options: { readonly logger?: RetitleLogger; readonly timeoutMs?: number; readonly limit?: number } = {},
): Promise<RetitleMessage[]> {
  const { logger } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS
  const limit = Math.min(options.limit ?? MESSAGE_PAGE_LIMIT, MESSAGE_PAGE_LIMIT)
  if (typeof client.message?.list !== "function") {
    logger?.event("history-unsupported", { sessionID })
    return []
  }
  const deadline = createDeadline(timeoutMs, "history")
  try {
    const page = await withDeadline(
      client.message.list({ sessionID, limit, order: "desc" }, { signal: deadline.signal }),
      deadline,
    )
    const messages = normalizeMessagePage(page)
    logger?.event("history-loaded", { sessionID, messageCount: messages.length, limit })
    return normalizeMessages([...messages].reverse() as ReadonlyArray<RawSessionMessage>)
  } catch (error) {
    logger?.event("history-error", { sessionID, error, timedOut: error instanceof RetitleTimeoutError })
    return []
  } finally {
    deadline.dispose()
  }
}

export type GenerateTitleInput = {
  readonly client: SessionApiClient
  /** Session whose location pins the generation; the helper inherits it. */
  readonly location?: LocationLike
  readonly model: ModelRefLike
  readonly prompt: string
  readonly logger?: RetitleLogger
  readonly generateTimeoutMs?: number
  readonly helperTimeoutMs?: number
  readonly cleanupTimeoutMs?: number
}

/**
 * Native on-demand title generation:
 *
 *   1. create a short-lived helper session pinned to the `title` agent and the
 *      resolved model (this is what makes the built-in title system prompt —
 *      `packages/core/src/plugin/agent.ts:155` — apply, matching V1 and the
 *      automatic titler);
 *   2. `session.generate` ("Generate transient text from the current session
 *      context without mutating session history") under one hard deadline;
 *   3. remove the helper in `finally`, on its own deadline, always.
 *
 * No polling: `session.generate` returns the text, so there is no window in
 * which a second run could observe a first run's helper.
 */
export async function generateTitleText(input: GenerateTitleInput): Promise<string | undefined> {
  const { client, logger } = input
  const session = client.session ?? {}
  const createHelper = session.create
  const generate = session.generate
  if (typeof generate !== "function" || typeof createHelper !== "function") {
    throw new RetitleError(
      "unsupported",
      "This OpenCode V2 runtime does not expose session.generate; /retitle needs it",
    )
  }

  const helperDeadline = createDeadline(input.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS, "helper-create")
  let helperID: string | undefined
  try {
    const created = await withDeadline(
      createHelper(
        {
          title: HELPER_TITLE,
          agent: TITLE_AGENT,
          model: input.model,
          ...(input.location ? { location: input.location } : {}),
        },
        { signal: helperDeadline.signal },
      ),
      helperDeadline,
    )
    helperID = normalizeCreatedSessionID(created)
  } catch (error) {
    logger?.event("helper-create-error", { error, timedOut: error instanceof RetitleTimeoutError })
    throw error instanceof RetitleError
      ? error
      : new RetitleError("helper-create", "Failed to create retitle helper session", error)
  } finally {
    helperDeadline.dispose()
  }
  if (!helperID) throw new RetitleError("helper-create", "Failed to create retitle helper session")
  logger?.event("helper-created", { helperSessionID: helperID })

  const generateDeadline = createDeadline(input.generateTimeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS, "generate")
  try {
    const result = await withDeadline(
      generate({ sessionID: helperID, prompt: input.prompt }, { signal: generateDeadline.signal }),
      generateDeadline,
    )
    const text = normalizeGeneratedText(result)
    const rawLength = rawTextLength(result)
    if (rawLength > MAX_GENERATED_TEXT_LENGTH) {
      logger?.event("generate-truncated", { helperSessionID: helperID, rawLength, maxLength: MAX_GENERATED_TEXT_LENGTH })
    }
    logger?.event("generate-done", {
      helperSessionID: helperID,
      hasText: Boolean(text),
      textLength: text?.length ?? 0,
    })
    return text
  } catch (error) {
    logger?.event("generate-error", { helperSessionID: helperID, error, timedOut: error instanceof RetitleTimeoutError })
    throw error instanceof RetitleTimeoutError
      ? error
      : new RetitleError("generate", "Title generation failed", error)
  } finally {
    generateDeadline.dispose()
    await removeHelper(session, helperID, input.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS, logger)
  }
}

async function removeHelper(
  session: NonNullable<SessionApiClient["session"]>,
  helperID: string,
  timeoutMs: number,
  logger?: RetitleLogger,
): Promise<void> {
  if (typeof session.remove !== "function") return
  const deadline = createDeadline(timeoutMs, "helper-cleanup")
  try {
    await withDeadline(session.remove({ sessionID: helperID }, { signal: deadline.signal }), deadline)
    logger?.event("helper-removed", { helperSessionID: helperID })
  } catch (error) {
    // A leaked helper is a wart, not a failure: the run's result is already
    // settled, so this must never replace it or reject the finally path.
    logger?.event("helper-remove-error", {
      helperSessionID: helperID,
      error,
      timedOut: error instanceof RetitleTimeoutError,
    })
  } finally {
    deadline.dispose()
  }
}

/**
 * Applies a title through the public rename method. The client method is
 * `session.rename` on both known revisions even though the underlying request
 * differs; nothing here depends on which one is installed.
 */
export async function applySessionTitle(
  client: SessionApiClient,
  sessionID: string,
  title: string,
  options: { readonly logger?: RetitleLogger; readonly timeoutMs?: number } = {},
): Promise<void> {
  const session = client.session ?? {}
  if (typeof session.rename !== "function") {
    throw new RetitleError("unsupported", "This OpenCode V2 runtime does not expose session.rename")
  }
  const deadline = createDeadline(options.timeoutMs ?? DEFAULT_RENAME_TIMEOUT_MS, "rename")
  try {
    await withDeadline(session.rename({ sessionID, title }, { signal: deadline.signal }), deadline)
    options.logger?.event("title-updated", { sessionID, titleLength: title.length })
  } catch (error) {
    options.logger?.event("title-update-error", { sessionID, error, timedOut: error instanceof RetitleTimeoutError })
    throw error instanceof RetitleTimeoutError
      ? error
      : new RetitleError("rename", "Failed to update session title", error)
  } finally {
    deadline.dispose()
  }
}

function rawTextLength(value: unknown): number {
  if (typeof value === "string") return value.length
  if (!value || typeof value !== "object") return 0
  const record = value as { readonly text?: unknown; readonly data?: unknown }
  if (typeof record.text === "string") return record.text.length
  const nested = record.data && typeof record.data === "object" ? (record.data as { text?: unknown }).text : undefined
  return typeof nested === "string" ? nested.length : 0
}
