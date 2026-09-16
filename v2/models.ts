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
// A configured override is never silently replaced: if the catalogue is loaded
// and does not contain it, the run fails with an actionable message instead of
// quietly generating with a different model.

import {
  buildModelOptions,
  isModelAvailable,
  modelKey,
  parseModelString,
  pickModel,
  type AvailableModel,
  type ModelOption,
  type ModelRef,
  type RetitleMessage,
} from "./retitle-core"
import { RetitleError } from "./errors"

export { modelKey } from "./retitle-core"
export type { AvailableModel, ModelOption, ModelRef }

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
  /** Persisted `provider/model` override. Highest priority. */
  readonly override?: string
  readonly source: CatalogSource
  readonly sessionModel?: ModelRefLike | null
  readonly messages?: ReadonlyArray<RetitleMessage>
}

/**
 * Picks the generation model and validates it against the loaded catalogue.
 *
 * @throws RetitleError("model") when a configured override is unknown, when the
 * catalogue is loaded but the selection is absent, or when nothing can serve
 * the request at all.
 */
export function resolveTitleModel(input: ResolveModelInput): ModelRef {
  const override = input.override?.trim()
  if (override && !parseModelString(override)) {
    throw new RetitleError("model", `Invalid model reference in settings: ${override}`)
  }

  const available = listModels(input.source)
  const agentModel = titleAgentModel(input.source)
  const model = pickModel({
    override,
    agentModel: agentModel ? { providerID: agentModel.providerID, id: agentModel.modelID, variant: agentModel.variant } : undefined,
    sessionModel: input.sessionModel,
    messages: input.messages,
    available,
  })
  if (!model) {
    throw new RetitleError("model", "Connect a provider before using /retitle")
  }

  // The catalogue is authoritative when it is loaded. An empty catalogue means
  // the read failed, not that the model is invalid, so it is not a failure.
  if (available.length > 0 && !isModelAvailable(model, available)) {
    const label = modelKey(model)
    throw new RetitleError(
      "model",
      override
        ? `Model from settings is not available in this runtime: ${label}`
        : `Model not available: ${label}`,
    )
  }

  return model
}

export function modelOptions(source: CatalogSource, current: string): ModelOption[] {
  return buildModelOptions(listModels(source), listProviders(source), current)
}
