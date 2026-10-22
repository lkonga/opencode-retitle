// Context -> ports adapter.
//
// This is the only module that knows the shape of `Plugin.Context`; everything
// else depends on the narrow interfaces declared next to it. That keeps the
// public-API surface of the plugin auditable in one place and lets the runner,
// the gate, the logger and the dialogs be tested without a TUI.

import {
  normalizeMessages,
  type RawSessionMessage,
} from "./retitle-core"
import {
  loadSessionMessages,
  applySessionTitle,
  refreshSessionTitle,
  generateTitleText,
  MESSAGE_PAGE_LIMIT,
  type LocationLike,
  type SessionApiClient,
} from "./session-api"
import {
  ensureCatalog,
  modelKey,
  resolveTitleModel,
  titleAgentModel,
  type CatalogSource,
  type ModelRefLike as CatalogModelRef,
} from "./models"
import { createSettingsStore, type SettingsStorage, type SettingsStore } from "./settings"
import { createRunGate, createDebouncer, type RunGate } from "./gate"
import { createRetitleLogger, type RetitleLogger } from "./logger"
import { createProgressController, type ProgressController, type ProgressSurface } from "./progress"
import type { RetitlePorts } from "./runner"
import { TitleCandidateQueue } from "./shadow"

export interface SessionInfoLike {
  readonly model?: CatalogModelRef | null
}

/** Structural projection of `Plugin.Context` (nothing outside the documented API). */
export interface RetitleContext {
  readonly client: SessionApiClient
  readonly location?: LocationLike | undefined
  readonly data: {
    readonly location: CatalogSource & { default(): LocationLike }
    readonly session: {
      get(sessionID: string): SessionInfoLike | undefined
      /** Reactive refresh of the session row itself (title lives here). */
      sync?(sessionID: string): Promise<void>
      invalidate?(sessionID: string): void
      readonly message: {
        list(sessionID: string): ReadonlyArray<RawSessionMessage>
        sync(sessionID: string): Promise<void>
      }
    }
  }
  readonly storage: SettingsStorage
}

/** Degrades a missing reactive collection to an empty one. */
function collection<Value>(value: CatalogCollection<Value> | undefined): CatalogCollection<Value> {
  if (!value || typeof value.list !== "function") return { list: () => [] }
  return value
}

function safely<Value>(read: () => Value, fallback: Value, onError?: (error: unknown) => void): Value {
  try {
    return read()
  } catch (error) {
    onError?.(error)
    return fallback
  }
}

export interface AdapterOptions {
  readonly logger?: RetitleLogger
  readonly gate?: RunGate
  /** Failure-toast debounce window, ms. */
  readonly toastWindowMs?: number
  readonly now?: () => number
  /**
   * Public UI surface for generation/apply progress. The TUI entry binds it to
   * `context.ui.dialog` (`show`/`clear`); without one, progress is a no-op.
   */
  readonly progressSurface?: ProgressSurface
}

export const DEFAULT_TOAST_WINDOW_MS = 15 * 60 * 1000

export interface RetitleAdapter {
  readonly ports: RetitlePorts
  readonly settings: SettingsStore
  readonly logger: RetitleLogger
  readonly gate: RunGate
  readonly candidates?: TitleCandidateQueue
  /** One progress controller per activation (see `progress.ts`). */
  readonly progress: ProgressController
  /** True when this failure key should raise a toast (debounced). */
  readonly toastAllowed: (key: string) => boolean
  /** Public reactive catalogue used by the model picker and labels. */
  readonly catalog: () => CatalogSource
}

export function createRetitleAdapter(context: RetitleContext, options: AdapterOptions = {}): RetitleAdapter {
  const logger = options.logger ?? createRetitleLogger()
  const gate = options.gate ?? createRunGate({ now: options.now })
  const now = options.now ?? (() => Date.now())
  const toastDebouncer = createDebouncer({ windowMs: options.toastWindowMs ?? DEFAULT_TOAST_WINDOW_MS, now })
  const progress = createProgressController(options.progressSurface, logger)

  const logFailure = (error: unknown) => logger.event("adapter-read-error", { error })

  // The reactive collections are documented API, but a runtime revision that
  // stops publishing one must degrade to "no model available" rather than crash
  // the command. Same for the synced message store.
  const catalog = (): CatalogSource => ({
    model: collection(context.data?.location?.model),
    provider: collection(context.data?.location?.provider),
    agent: collection(context.data?.location?.agent),
  })

  const location = (): LocationLike | undefined =>
    context.location ?? safely(() => context.data.location.default(), undefined, logFailure)

  const sessionRefFor = (sessionID: string) =>
    safely(() => context.data.session.get(sessionID)?.model ?? undefined, undefined, logFailure)

  const ports: RetitlePorts = {
    async loadMessages(sessionID) {
      const fromClient = await loadSessionMessages(context.client, sessionID, { logger })
      if (fromClient.length > 0) return fromClient

      // Client read failed or returned nothing: fall back to the host's synced
      // store. Still bounded, and normalized the same way.
      await safely(() => context.data.session.message.sync(sessionID), Promise.resolve(), logFailure).catch(() => {})
      const fromStore = safely(
        () => normalizeMessages(context.data.session.message.list(sessionID)),
        [],
        logFailure,
      )
      logger.event("history-store-fallback", { sessionID, messageCount: fromStore.length })
      return fromStore.slice(-MESSAGE_PAGE_LIMIT)
    },

    async resolveModel(sessionID, messages, override) {
      await ensureCatalog(catalog())
      const resolution = resolveTitleModel({
        override,
        source: catalog(),
        sessionModel: sessionRefFor(sessionID),
        messages,
      })
      // Metadata only: which model, which chain step produced it, and how many
      // preferences were stale. Never the prompt, the transcript or the title.
      logger.event("model-selected", {
        sessionID,
        providerID: resolution.model.providerID,
        modelID: resolution.model.modelID,
        modelSource: resolution.source,
        hasOverride: Boolean(override),
        skippedModelCount: resolution.skipped.length,
      })
      const staleTitleAgent = resolution.skipped.find((item) => item.source === "title-agent")
      if (staleTitleAgent) {
        // An inherited `agents.title.model` that this runtime cannot serve: the
        // chain continued, so this is a diagnostic, not a failure.
        logger.event("title-agent-model-unavailable", {
          sessionID,
          providerID: staleTitleAgent.model.providerID,
          modelID: staleTitleAgent.model.modelID,
        })
      }
      return resolution.model
    },

    generateTitle({ prompt, model }) {
      return generateTitleText({
        client: context.client,
        location: location(),
        model: {
          id: model.modelID,
          providerID: model.providerID,
          ...(model.variant ? { variant: model.variant } : {}),
        },
        prompt,
        logger,
      })
    },

    async applyTitle(sessionID, title) {
      // Write first: a failed write reports its own typed error. Only once the
      // server accepted the title is the reactive store refreshed, and a refresh
      // failure is contained inside `refreshSessionTitle` so a successful write
      // can never be reported as a failed apply.
      await applySessionTitle(context.client, sessionID, title, { logger })
      await refreshSessionTitle(context.data?.session, sessionID, { logger })
    },
  }

  return {
    ports,
    settings: createSettings(context, logger),
    logger,
    gate,
    candidates: createCandidates(context, logger),
    progress,
    toastAllowed: (key) => toastDebouncer.allow(key),
    catalog,
  }
}

/**
 * Title candidate queue, or undefined when the host storage is unusable.
 */
function createCandidates(context: RetitleContext, logger: RetitleLogger): TitleCandidateQueue | undefined {
  try {
    return new TitleCandidateQueue(context.storage)
  } catch (error) {
    logger.event("candidate-queue-error", { error })
    return undefined
  }
}

/**
 * Durable settings, or an in-memory store when the host storage is unusable.
 * A settings write must never be able to disable /retitle.
 */
function createSettings(context: RetitleContext, logger: RetitleLogger): SettingsStore {
  try {
    return createSettingsStore(context.storage)
  } catch (error) {
    logger.event("settings-store-error", { error })
    let model = ""
    return {
      read: () => ({ model }),
      setModel: (value) => {
        model = value.trim()
        return Promise.resolve()
      },
    }
  }
}

/**
 * Label for the model a run would use: the configured override, else the title
 * agent's model (the V1 `small_model` equivalent), else `auto`.
 */
export function effectiveModelLabel(source: CatalogSource, override: string): string {
  if (override.trim()) return override.trim()
  const agent = titleAgentModel(source)
  return agent ? modelKey(agent) : "auto"
}

/**
 * Narrows the plugin's `Context` to the adapter's structural view. `Context` is
 * a superset of `RetitleContext`; the only mismatch is parameter variance in the
 * generated client, which differs between runtime revisions. This is the single
 * place where that narrowing happens, so the rest of the plugin is checked
 * against the documented surface rather than an `any`.
 */
export function toRetitleContext(context: unknown): RetitleContext {
  return context as RetitleContext
}
