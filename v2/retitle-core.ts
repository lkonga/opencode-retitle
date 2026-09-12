// Pure retitle logic shared by the V2 TUI plugin.
//
// This module deliberately has no imports from the V2 runtime so it can be
// unit-tested with `bun test` without booting the TUI. The V1 entrypoint
// (`../tui.ts`) keeps its own copy of these rules and is not affected by it.

export const MAX_SAMPLE_TEXT_LENGTH = 200

/** V2 `ModelRef` shape (`@opencode-ai/client`): the model id field is `id`. */
export type ModelRef = {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

export type SamplingOptions = {
  readonly maxSamples?: number
  readonly fromPercent?: number
  readonly offset?: number
}

export type RetitleSettings = {
  samples: number
  offset: number
  fromPct: number
  steering: string
  /** provider/model override for this run; empty = use the title agent / catalog fallbacks */
  model: string
}

export type SampledMessage = {
  index: number
  role: "user" | "assistant"
  text: string
}

/** Normalized message, decoupled from the wire `SessionMessageInfo` union. */
export type RetitleMessage = {
  role: "user" | "assistant"
  text: string
  model?: ModelRef
  error?: string
}

/** Structural subset of V2 `SessionMessageInfo` that retitle reads. */
export type RawSessionMessage = {
  readonly type?: string
  readonly text?: string
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string } | null | undefined> | null
  readonly model?: { readonly id?: string; readonly providerID?: string; readonly variant?: string } | null
  readonly error?: { readonly message?: string } | string | null
}

export type ModelOption = {
  readonly title: string
  readonly value: string
  readonly description?: string
  readonly category?: string
}

export type AvailableModel = {
  readonly id: string
  readonly providerID: string
  readonly name?: string
  readonly status?: string
  readonly enabled?: boolean
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function errorText(error: RawSessionMessage["error"]): string | undefined {
  if (!error) return undefined
  if (typeof error === "string") return text(error)
  return text(error.message)
}

function toModelRef(model: RawSessionMessage["model"] | undefined | null): ModelRef | undefined {
  if (!model) return undefined
  const providerID = text(model.providerID)
  const modelID = text(model.id)
  if (!providerID || !modelID) return undefined
  return { providerID, modelID, ...(text(model.variant) ? { variant: model.variant } : {}) }
}

function assistantContent(message: RawSessionMessage): string | undefined {
  if (!Array.isArray(message.content)) return undefined
  const joined = message.content
    .filter((part) => part?.type === "text")
    .map((part) => String(part?.text ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim()
  return joined || undefined
}

/**
 * Projects the V2 wire union onto the two roles retitle samples. Synthetic and
 * system messages are ignored, matching the V1 user/assistant-only sampling.
 */
export function normalizeMessages(raw: ReadonlyArray<RawSessionMessage> | undefined | null): RetitleMessage[] {
  const result: RetitleMessage[] = []
  for (const message of raw ?? []) {
    if (!message) continue
    if (message.type === "user") {
      const value = text(message.text)
      if (value) result.push({ role: "user", text: value })
      continue
    }
    if (message.type === "assistant") {
      result.push({
        role: "assistant",
        text: assistantContent(message) ?? "",
        model: toModelRef(message.model),
        error: errorText(message.error),
      })
    }
  }
  return result
}

export function truncateText(value: string): string {
  if (value.length <= MAX_SAMPLE_TEXT_LENGTH) return value
  return value.slice(0, MAX_SAMPLE_TEXT_LENGTH) + "..."
}

export function parseRetitleArgs(raw?: string): { steeringHint?: string; samplingOptions?: SamplingOptions } {
  if (!raw) return {}

  let maxSamples: number | undefined
  let fromPercent: number | undefined
  let offset: number | undefined
  let remaining = raw

  const samplesMatch = remaining.match(/--samples\s+(\d+)/)
  if (samplesMatch) {
    maxSamples = Math.max(3, Math.min(50, parseInt(samplesMatch[1], 10)))
    remaining = remaining.replace(samplesMatch[0], "")
  }

  const offsetMatch = remaining.match(/--offset\s+(\d+)/)
  if (offsetMatch) {
    offset = Math.max(1, parseInt(offsetMatch[1], 10))
    remaining = remaining.replace(offsetMatch[0], "")
  }

  const fromMatch = remaining.match(/--from\s+(\d+)/)
  if (fromMatch) {
    fromPercent = Math.max(0, Math.min(100, parseInt(fromMatch[1], 10)))
    remaining = remaining.replace(fromMatch[0], "")
  }

  const steeringHint = remaining.trim() || undefined
  const samplingOptions =
    maxSamples !== undefined || fromPercent !== undefined || offset !== undefined
      ? { maxSamples, fromPercent, offset }
      : undefined

  return { steeringHint, samplingOptions }
}

export function settingsToArgs(settings: RetitleSettings): string {
  const parts: string[] = []
  if (settings.samples !== 10) parts.push(`--samples ${settings.samples}`)
  if (settings.offset > 0) parts.push(`--offset ${settings.offset}`)
  if (settings.fromPct !== 100) parts.push(`--from ${settings.fromPct}`)
  if (settings.steering.trim()) parts.push(settings.steering.trim())
  return parts.join(" ")
}

/** First assistant message text following a user turn, stopping at the next user turn. */
function nextAssistantText(messages: ReadonlyArray<RetitleMessage>, from: number): string | undefined {
  for (let index = from + 1; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === "user") break
    if (message.role === "assistant" && message.text) return message.text
  }
  return undefined
}

/**
 * Tail-3 plus spread sampling, ported 1:1 from the V1 plugin
 * (`../tui.ts` `sampleTurns`). `index` is the user-turn ordinal used in the
 * title prompt; lookahead happens on the raw message array.
 */
export function sampleTurns(
  messages: ReadonlyArray<RetitleMessage>,
  options?: SamplingOptions,
): SampledMessage[] {
  const offset = options?.offset
  const baseMessages = offset !== undefined ? messages.slice(-Math.min(offset, messages.length)) : messages
  const userTurns = baseMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user" && Boolean(message.text))

  if (userTurns.length === 0) return []

  const MAX_SAMPLES = Math.min(options?.maxSamples ?? 10, userTurns.length)
  const TAIL = Math.min(3, MAX_SAMPLES)

  let windowStart: number
  let windowLen: number

  if (offset !== undefined) {
    windowStart = 0
    windowLen = userTurns.length
  } else {
    const from = options?.fromPercent ?? 100
    const WINDOW = Math.min(userTurns.length, Math.max(MAX_SAMPLES, 50))
    const focusCenter = Math.round((from / 100) * (userTurns.length - 1))
    const halfWindow = Math.floor(WINDOW / 2)
    const rawStart = focusCenter - halfWindow
    windowStart = Math.max(0, Math.min(rawStart, userTurns.length - WINDOW))
    windowLen = Math.min(WINDOW, userTurns.length - windowStart)
  }

  let selectedTurns: Array<{ idx: number; message: RetitleMessage; index: number }>

  if (windowLen <= MAX_SAMPLES) {
    selectedTurns = userTurns.slice(windowStart).map((entry, i) => ({ idx: windowStart + i, ...entry }))
  } else {
    const sampleIndices = new Set<number>()
    for (let i = Math.max(0, userTurns.length - TAIL); i < userTurns.length; i++) sampleIndices.add(i)

    const spreadCount = MAX_SAMPLES - TAIL
    if (spreadCount > 0) {
      const spreadEnd = userTurns.length - TAIL
      const spreadLen = Math.max(1, spreadEnd - windowStart)
      for (let i = 0; i < spreadCount; i++) {
        const idx =
          spreadCount > 1
            ? windowStart + Math.round((i * (spreadLen - 1)) / (spreadCount - 1))
            : windowStart + Math.round((spreadLen - 1) / 2)
        sampleIndices.add(Math.max(0, Math.min(idx, userTurns.length - 1)))
      }
    }

    selectedTurns = [...sampleIndices]
      .sort((a, b) => a - b)
      .slice(0, MAX_SAMPLES)
      .map((idx) => ({ idx, ...userTurns[idx] }))
  }

  const result: SampledMessage[] = []
  for (const { idx, message, index } of selectedTurns) {
    if (!message.text) continue
    result.push({ index: idx, role: "user", text: truncateText(message.text) })

    const assistantText = nextAssistantText(baseMessages, index)
    if (assistantText) result.push({ index: idx, role: "assistant", text: truncateText(assistantText) })
  }
  return result
}

export function titlePrompt(sampledMessages: ReadonlyArray<SampledMessage>, steeringHint?: string): string {
  const messageList = sampledMessages.map((message) => `[Turn ${message.index + 1} ${message.role}]: ${message.text}`).join("\n")
  const hint = steeringHint
    ? `\nIMPORTANT: The user has provided the following directive for the title. Follow it closely:\n${steeringHint}\n`
    : ""

  return `You are an expert in crafting pithy titles for chatbot conversations. You are presented with sampled messages from different points in a conversation, and you reply with a brief title that captures the main topic of the conversation as it evolved.

The title should not be wrapped in quotes. It should be about 14 words or fewer.${hint}

Here are some examples of good titles:
- Git rebase question
- Installing Python packages
- Location of LinkedList implementation in codebase
- Adding a tree view to a VS Code extension
- React useState hook usage
- Rate limiter burst config and integration tests
- Fork status bar with effort level and output token limits

Please write a brief title for the following conversation. These are sampled messages from different points — focus on what the session is currently about:

${messageList}`
}

export function cleanTitle(value: string): string | undefined {
  const cleaned = value
    .replace(/<think[\s\S]*?<\/think>\s*/g, "")
    .replace(/<think[\s\S]*?(?=\n\n|$)/g, "")
    .replace(/<thinking[\s\S]*?<\/thinking>\s*/g, "")
    .replace(/<thinking[\s\S]*?(?=\n\n|$)/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^["'](.*)["']$/, "$1")
    .trim()
  if (!cleaned || isRefusal(cleaned)) return undefined
  return cleaned.length > 100 ? cleaned.slice(0, 97) + "..." : cleaned
}

export function parseModelString(input: string): ModelRef | undefined {
  const slash = input.indexOf("/")
  if (slash <= 0 || slash >= input.length - 1) return undefined
  return { providerID: input.slice(0, slash), modelID: input.slice(slash + 1) }
}

export function modelKey(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`
}

export function formatModelLabel(model: ModelRef | undefined, override?: string): string {
  if (override?.trim()) return override.trim()
  if (model) return modelKey(model)
  return "(auto)"
}

export function latestAssistantText(messages: ReadonlyArray<RetitleMessage>): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    if (message.text) return message.text
  }
  return undefined
}

export function latestAssistantError(messages: ReadonlyArray<RetitleMessage>): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    if (message.error) return message.error
  }
  return undefined
}

export type ModelCandidates = {
  /** Persisted settings override, `provider/model`. Highest priority. */
  readonly override?: string
  /** V2 equivalent of V1 `small_model`: the built-in `title` agent's model. */
  readonly agentModel?: { readonly providerID?: string; readonly id?: string; readonly variant?: string } | null
  /** The session's currently selected model. */
  readonly sessionModel?: { readonly providerID?: string; readonly id?: string; readonly variant?: string } | null
  readonly messages?: ReadonlyArray<RetitleMessage>
  /** Catalog fallback list (`data.location.model.list()`). */
  readonly available?: ReadonlyArray<AvailableModel>
}

function refFrom(value: { providerID?: string; id?: string; variant?: string } | null | undefined): ModelRef | undefined {
  if (!value) return undefined
  const providerID = text(value.providerID)
  const modelID = text(value.id)
  if (!providerID || !modelID) return undefined
  return { providerID, modelID, ...(text(value.variant) ? { variant: value.variant } : {}) }
}

/**
 * Resolution order, mirroring V1 (`pickSessionModel`):
 * settings override -> title agent model (V1 `small_model`) -> session model ->
 * first assistant message model -> first enabled, non-deprecated catalog model.
 */
export function pickModel(candidates: ModelCandidates): ModelRef | undefined {
  const override = candidates.override ? parseModelString(candidates.override) : undefined
  if (override) return override

  const agent = refFrom(candidates.agentModel)
  if (agent) return agent

  const session = refFrom(candidates.sessionModel)
  if (session) return session

  for (const message of candidates.messages ?? []) {
    if (message.role === "assistant" && message.model) return message.model
  }

  for (const model of candidates.available ?? []) {
    if (model.enabled === false) continue
    if (model.status === "deprecated") continue
    return { providerID: model.providerID, modelID: model.id }
  }
  return undefined
}

export function isModelAvailable(model: ModelRef, available: ReadonlyArray<AvailableModel>): boolean {
  return available.some((item) => item.providerID === model.providerID && item.id === model.modelID)
}

export function buildModelOptions(
  models: ReadonlyArray<AvailableModel>,
  providers: ReadonlyArray<{ readonly id: string; readonly name?: string }>,
  current: string,
): ModelOption[] {
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name || provider.id]))

  const options: ModelOption[] = [
    {
      title: "Use agent title / auto",
      value: "",
      description:
        current === ""
          ? "← current"
          : "Prefer the title agent's model (V1 small_model), then the session model, then the catalog",
      category: "Default",
    },
  ]

  for (const model of models) {
    if (model.status === "deprecated") continue
    if (model.enabled === false) continue
    const fullId = `${model.providerID}/${model.id}`
    options.push({
      title: model.name || model.id,
      value: fullId,
      description: fullId === current ? "← current" : fullId,
      category: providerNames.get(model.providerID) ?? model.providerID,
    })
  }

  options.sort((a, b) => {
    if (a.value === current) return -1
    if (b.value === current) return 1
    if (a.value === "") return -1
    if (b.value === "") return 1
    return a.title.localeCompare(b.title)
  })
  return options
}

export function isRefusal(value: string): boolean {
  return /\b(cannot|can't|can not|won't|unable)\s+(assist|help|fulfill|complete)/i.test(value)
}
