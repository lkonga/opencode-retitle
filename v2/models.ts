// Model catalogue reads and title-model selection for /retitle.
//
// V1 resolved `small_model` from `opencode.jsonc` and the provider state. V2
// migrates `small_model` to the built-in `title` agent's model
// (`packages/core/src/config/normalize.ts:123-140`,
// `packages/core/src/plugin/agent.ts:155`), so the same preference is read from
// `data.location.agent.list()` — a public reactive collection — and the
// priority chain is otherwise unchanged:
//
//   settings override -> title agent model (V1 `small_model`) -> session model
//   -> first assistant message model -> first enabled, non-deprecated catalogue model
//
// Two different kinds of failure are handled differently on purpose:
//
//   * The **settings override** is an explicit user choice, so it is strict and
//     fail-closed: if the catalogue is loaded and does not contain it, the run
//     fails with an actionable message instead of quietly generating with a
//     different model.
//   * The **title agent model** is inherited configuration, not a choice made
//     for this run. It is preferred only when the loaded catalogue carries it;
//     a stale value (e.g. a provider that no longer exists in this runtime) is
//     skipped and the chain continues to the session model, the first assistant
//     message's model, or the first enabled catalogue model. No model is ever
//     hardcoded.
//
// Both rules share one caveat: an *empty* catalogue means the read failed, not
// that a model is invalid, so nothing is skipped in that case.

import {
  assistantMessageModel,
  buildModelOptions,
  isModelAvailable,
  modelKey,
  parseModelString,
  pickModel,
  type AvailableModel,
  type ModelOption,
  type ModelRef,
  type ModelSource,
  type RetitleMessage,
} from "./retitle-core"
import { RetitleError } from "./errors"

export { modelKey } from "./retitle-core"
export type { AvailableModel, ModelOption, ModelRef, ModelSource }

export interface AgentLike {
  readonly id: string
  readonly model?: ModelRefLike | null
}

export interface ProviderLike {
  readonly id: string
  readonly name?: string
}

export interface ModelRefLike {
  readonly id?: string
  readonly providerID?: string
  readonly variant?: string
}

export interface CatalogCollection<Value> {
  list(): ReadonlyArray<Value> | undefined
  sync?(): Promise<void>
}

/** Structural projection of `context.data.location` (see `models` in the audit). */
export interface CatalogSource {
  readonly model: CatalogCollection<AvailableModel>
  readonly provider: CatalogCollection<ProviderLike>
  readonly agent: CatalogCollection<AgentLike>
}

const TITLE_AGENT_ID = "title"

/** Loads the collections the resolver needs when the host has not synced yet. */
export async function ensureCatalog(source: CatalogSource): Promise<void> {
  if ((source.model.list() ?? []).length === 0) await source.model.sync?.().catch(() => {})
  if ((source.provider.list() ?? []).length === 0) await source.provider.sync?.().catch(() => {})
  if ((source.agent.list() ?? []).length === 0) await source.agent.sync?.().catch(() => {})
}

export function listModels(source: CatalogSource): AvailableModel[] {
  return [...(source.model.list() ?? [])]
}

export function listProviders(source: CatalogSource): ProviderLike[] {
  return [...(source.provider.list() ?? [])]
}

/**
 * The V2 equivalent of V1 `small_model`: the built-in `title` agent's model,
 * which is where a V1 `small_model` is migrated to.
 */
export function titleAgentModel(source: CatalogSource): ModelRef | undefined {
  const agent = (source.agent.list() ?? []).find((item) => item.id === TITLE_AGENT_ID)
  const ref = agent?.model
  return toRef(ref)
}

function toRef(value: ModelRefLike | null | undefined): ModelRef | undefined {
  if (!value) return undefined
  const providerID = typeof value.providerID === "string" ? value.providerID.trim() : ""
  const modelID = typeof value.id === "string" ? value.id.trim() : ""
  const variant = typeof value.variant === "string" ? value.variant.trim() : ""
  if (!providerID || !modelID) return undefined
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

export type ResolveModelInput = {
  /** Persisted `provider/model` override. Highest priority, and fail-closed. */
  readonly override?: string
  readonly source: CatalogSource
  readonly sessionModel?: ModelRefLike | null
  readonly messages?: ReadonlyArray<RetitleMessage>
}

/** A preference candidate the loaded catalogue rejected. */
export type SkippedModel = {
  readonly model: ModelRef
  readonly source: ModelSource
}

export type ModelResolution = {
  readonly model: ModelRef
  readonly source: ModelSource
  /** Preference candidates that were stale, in preference order. Metadata only. */
  readonly skipped: ReadonlyArray<SkippedModel>
}

/**
 * Picks the generation model, validating each preference against the loaded
 * catalogue.
 *
 * @throws RetitleError("model") when an explicit override is malformed or the
 * loaded catalogue does not carry it, and when nothing at all can serve the
 * request.
 */
export function resolveTitleModel(input: ResolveModelInput): ModelResolution {
  const available = listModels(input.source)
  const catalogLoaded = available.length > 0
  const usable = (model: ModelRef): boolean => !catalogLoaded || isModelAvailable(model, available)

  const override = input.override?.trim()
  if (override) {
    const parsed = parseModelString(override)
    if (!parsed) {
      throw new RetitleError("model", `Invalid model reference in settings: ${override}`)
    }
    // Strict and fail-closed: an explicit choice is never silently replaced.
    if (!usable(parsed)) {
      throw new RetitleError(
        "model",
        `Model from settings is not available in this runtime: ${modelKey(parsed)}`,
      )
    }
  }

  const agentModel = titleAgentModel(input.source)
  const sessionModel = toRef(input.sessionModel)
  const assistantModel = assistantMessageModel(input.messages)

  const picked = pickModel({
    override,
    agentModel,
    sessionModel,
    assistantModel,
    available,
    usable,
  })
  if (!picked) {
    throw new RetitleError(
      "model",
      catalogLoaded
        ? "No usable model for /retitle: every model in the catalogue is disabled or deprecated"
        : "Connect a provider before using /retitle",
    )
  }

  const skipped: SkippedModel[] = catalogLoaded
    ? [
        { model: agentModel, source: "title-agent" as const },
        { model: sessionModel, source: "session" as const },
        { model: assistantModel, source: "assistant-message" as const },
      ].flatMap((candidate) =>
        candidate.model && !usable(candidate.model)
          ? [{ model: candidate.model, source: candidate.source }]
          : [],
      )
    : []

  return { model: picked.model, source: picked.source, skipped }
}

export function modelOptions(source: CatalogSource, current: string): ModelOption[] {
  return buildModelOptions(listModels(source), listProviders(source), current)
}
