import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Message, Part, TextPart, Provider } from "@opencode-ai/sdk/v2"

type MessageWithParts = {
  info: Message
  parts: Array<Part>
}

type SampledMessage = {
  index: number
  role: "user" | "assistant"
  text: string
}

type SamplingOptions = {
  maxSamples?: number
  fromPercent?: number
  offset?: number
}

type RetitleSettings = {
  samples: number
  offset: number
  fromPct: number
  steering: string
}

const MAX_SAMPLE_TEXT_LENGTH = 200

function retitleLog(event: string, data: Record<string, unknown> = {}) {
  try {
    const fs = require("node:fs")
    fs.appendFileSync(
      process.env.OPENCODE_RETITLE_LOG || "/tmp/opencode-retitle.log",
      JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n",
    )
  } catch {}
}

function truncateText(text: string): string {
  if (text.length <= MAX_SAMPLE_TEXT_LENGTH) return text
  return text.slice(0, MAX_SAMPLE_TEXT_LENGTH) + "..."
}

function textFromParts(parts: Array<Part> | undefined | null): string | undefined {
  if (!parts || !Array.isArray(parts)) return undefined
  const text = parts
    .filter((part) => part?.type === "text" && !(part as any).ignored)
    .map((part) => String((part as TextPart).text ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim()
  return text || undefined
}

function parseRetitleArgs(raw?: string): { steeringHint?: string; samplingOptions?: SamplingOptions } {
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

function settingsToArgs(s: RetitleSettings): string {
  const parts: string[] = []
  if (s.samples !== 10) parts.push(`--samples ${s.samples}`)
  if (s.offset > 0) parts.push(`--offset ${s.offset}`)
  if (s.fromPct !== 100) parts.push(`--from ${s.fromPct}`)
  if (s.steering.trim()) parts.push(s.steering.trim())
  return parts.join(" ")
}

function sampleTurns(messages: ReadonlyArray<MessageWithParts>, options?: SamplingOptions): SampledMessage[] {
  const offset = options?.offset
  const baseMessages = offset !== undefined ? messages.slice(-Math.min(offset, messages.length)) : messages
  const userTurns = (baseMessages as Array<MessageWithParts>)
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.info?.role === "user" && textFromParts(message.parts))

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

  let selectedTurns: Array<{ idx: number; message: MessageWithParts; index: number }>

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
        const idx = spreadCount > 1
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
    const userText = textFromParts(message.parts)
    if (!userText) continue
    result.push({ index: idx, role: "user", text: truncateText(userText) })

    const next = baseMessages[index + 1] as MessageWithParts | undefined
    if (next?.info?.role === "assistant") {
      const assistantText = textFromParts(next.parts)
      if (assistantText) result.push({ index: idx, role: "assistant", text: truncateText(assistantText) })
    }
  }
  return result
}

function titlePrompt(sampledMessages: SampledMessage[], steeringHint?: string): string {
  const messageList = sampledMessages
    .map((m) => `[Turn ${m.index + 1} ${m.role}]: ${m.text}`)
    .join("\n")
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

function cleanTitle(text: string): string | undefined {
  const cleaned = text
    .replace(/<think[\s\S]*?<\/think>\s*/g, "")
    .replace(/<think[\s\S]*?(?=\n\n|$)/g, "")
    .replace(/<thinking[\s\S]*?<\/thinking>\s*/g, "")
    .replace(/<thinking[\s\S]*?(?=\n\n|$)/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^["'](.*)["']$/, "$1")
    .trim()
  if (!cleaned || /\b(cannot|can't|can not|won't|unable)\s+(assist|help|fulfill|complete)/i.test(cleaned)) return undefined
  return cleaned.length > 100 ? cleaned.slice(0, 97) + "..." : cleaned
}

function titleTextFromMessages(messages: readonly MessageWithParts[]): string {
  return [...messages]
    .reverse()
    .filter((message) => message.info?.role === "assistant")
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => String((part as TextPart).text ?? ""))
    .join("\n")
}

function parseModelString(input: string): { providerID: string; modelID: string } | undefined {
  const slash = input.indexOf("/")
  if (slash <= 0 || slash >= input.length - 1) return undefined
  return { providerID: input.slice(0, slash), modelID: input.slice(slash + 1) }
}

function pickSessionModel(
  messages: ReadonlyArray<MessageWithParts>,
  providers: ReadonlyArray<Provider>,
  smallModel?: string,
): { providerID: string; modelID: string } | undefined {
  if (smallModel) {
    const parsed = parseModelString(smallModel)
    if (parsed) return parsed
  }
  for (const msg of messages) {
    if (msg.info?.model?.providerID && msg.info?.model?.modelID) {
      return msg.info.model as { providerID: string; modelID: string }
    }
  }
  for (const provider of providers) {
    for (const modelID of Object.keys(provider.models ?? {})) {
      return { providerID: provider.id, modelID }
    }
  }
  return undefined
}

async function waitForGeneratedTitle(api: TuiPluginApi, childID: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const msgResp = await api.client.session.messages({ sessionID: childID })
    if (msgResp.error) {
      retitleLog("poll-error", { helperSessionID: childID, attempt, error: String(msgResp.error) })
      await new Promise((resolve) => setTimeout(resolve, 500))
      continue
    }
    const messages: Array<MessageWithParts> = msgResp.data ?? []
    const title = cleanTitle(titleTextFromMessages(messages))
    if (title) {
      retitleLog("title-ready", { helperSessionID: childID, attempt, messageCount: messages.length, titleLength: title.length })
      return title
    }
    if (attempt === 0 || attempt === 5 || attempt === 15 || attempt === 30 || attempt === 59) {
      retitleLog("title-poll", { helperSessionID: childID, attempt, messageCount: messages.length })
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  retitleLog("title-timeout", { helperSessionID: childID, attempts: 60 })
  return undefined
}

async function generateRetitle(api: TuiPluginApi, sessionID: string, rawArgs?: string): Promise<string | undefined> {
  retitleLog("start", { sessionID, hasArgs: Boolean(rawArgs?.trim()) })
  const { steeringHint, samplingOptions } = parseRetitleArgs(rawArgs)
  retitleLog("messages-fetch", { sessionID })
  const fetchResult = await api.client.session.messages({ sessionID })
  if (fetchResult.error) throw new Error("Failed to fetch session messages")
  const messages = (fetchResult.data ?? []) as Array<{ info: Message; parts: Array<Part> }>

  const sampled = sampleTurns(messages, samplingOptions)
  retitleLog("sampled", {
    sessionID,
    messageCount: messages.length,
    sampledCount: sampled.length,
    hasHint: Boolean(steeringHint),
    maxSamples: samplingOptions?.maxSamples,
    fromPercent: samplingOptions?.fromPercent,
    offset: samplingOptions?.offset,
  })
  if (sampled.length === 0) {
    retitleLog("no-samples", { sessionID, messageCount: messages.length })
    return undefined
  }

  const smallModel = (api.state.config as any)?.small_model as string | undefined
  const model = pickSessionModel(messages, api.state.provider, smallModel)
  if (!model) throw new Error("Connect a provider before using /retitle")
  retitleLog("model-selected", { sessionID, providerID: model.providerID, modelID: model.modelID })

  const childResp = await api.client.session.create({ parentID: sessionID, title: "Retitle generation" })
  if (childResp.error) throw new Error("Failed to create retitle helper session")
  const childID = childResp.data!.id
  retitleLog("helper-created", { sessionID, helperSessionID: childID })

  try {
    const promptResp = await api.client.session.prompt({
      sessionID: childID,
      noReply: false,
      agent: "title",
      model,
      parts: [{ type: "text", text: titlePrompt(sampled, steeringHint), synthetic: true }],
    })
    if (promptResp.error) throw new Error("Failed to start retitle prompt: " + String(promptResp.error))
    retitleLog("prompt-started", { sessionID, helperSessionID: childID })

    return await waitForGeneratedTitle(api, childID)
  } finally {
    api.client.session.delete({ sessionID: childID }).catch(() => {})
  }
}

async function applyTitle(api: TuiPluginApi, sessionID: string, title: string): Promise<boolean> {
  const updateResult = await api.client.session.update({ sessionID, title })
  if (updateResult.error) {
    retitleLog("update-error", { sessionID, error: String(updateResult.error) })
    api.ui.toast({ variant: "error", title: "Retitle", message: "Failed to update session title", duration: 5000 })
    return false
  }
  retitleLog("updated", { sessionID, titleLength: title.length })
  api.ui.toast({ variant: "success", title: "Retitle", message: "New title: " + title, duration: 6000 })
  return true
}

// ─── Confirm flow: Apply / Edit / Regenerate / Cancel ─────────────────────────

function showConfirmMenu(
  api: TuiPluginApi,
  sessionID: string,
  title: string,
  settings: RetitleSettings,
) {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `Retitle — "${title}"`,
      skipFilter: true,
      current: "apply",
      options: [
        {
          title: "Apply",
          value: "apply",
          description: "Set this as the session title",
          onSelect: () => {
            api.ui.dialog.clear()
            applyTitle(api, sessionID, title)
          },
        },
        {
          title: "Edit…",
          value: "edit",
          description: "Modify the title before applying",
          onSelect: () => {
            showEditPrompt(api, sessionID, title, settings)
          },
        },
        {
          title: "Regenerate",
          value: "regenerate",
          description: "Run again with different settings",
          onSelect: () => {
            showSettingsDialog(api, sessionID, settings)
          },
        },
        {
          title: "Cancel",
          value: "cancel",
          description: "Discard this title",
          onSelect: () => {
            api.ui.dialog.clear()
          },
        },
      ],
    }),
  )
}

function showEditPrompt(
  api: TuiPluginApi,
  sessionID: string,
  currentTitle: string,
  settings: RetitleSettings,
) {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Edit title",
      value: currentTitle,
      placeholder: "Session title",
      onConfirm: (value: string) => {
        const trimmed = value.trim()
        if (!trimmed) {
          showConfirmMenu(api, sessionID, currentTitle, settings)
          return
        }
        api.ui.dialog.clear()
        applyTitle(api, sessionID, trimmed)
      },
      onCancel: () => {
        showConfirmMenu(api, sessionID, currentTitle, settings)
      },
    }),
  )
}

// ─── Generation runner ────────────────────────────────────────────────────────

async function runRetitle(
  api: TuiPluginApi,
  sessionID: string,
  settings: RetitleSettings,
) {
  const args = settingsToArgs(settings)

  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Retitle Session",
      placeholder: "",
      busy: true,
      busyText: "Analyzing recent messages...",
      onConfirm: () => {},
      onCancel: () => {
        api.ui.dialog.clear()
      },
    }),
  )

  try {
    const title = await generateRetitle(api, sessionID, args)
    if (!title) {
      retitleLog("no-title", { sessionID })
      api.ui.dialog.clear()
      api.ui.toast({
        variant: "warning",
        title: "Retitle",
        message: "Unable to generate a title from this conversation",
        duration: 5000,
      })
      return
    }
    showConfirmMenu(api, sessionID, title, settings)
  } catch (error) {
    retitleLog("error", { sessionID, message: error instanceof Error ? error.message : String(error) })
    api.ui.dialog.clear()
    api.ui.toast({
      variant: "error",
      title: "Retitle failed",
      message: error instanceof Error ? error.message : String(error),
      duration: 7000,
    })
  }
}

// ─── Composable settings dialog ───────────────────────────────────────────────

function showSettingsDialog(
  api: TuiPluginApi,
  sessionID: string,
  settings: RetitleSettings,
) {
  const buildOpts = () => {
    const opts: Array<{ title: string; value: string; description?: string; category?: string; onSelect?: () => void }> = [
      {
        title: "Retitle with current settings",
        value: "run",
        category: "Run",
        description: `samples=${settings.samples}${settings.offset > 0 ? ` offset=${settings.offset}` : ""}${settings.fromPct !== 100 ? ` from=${settings.fromPct}%` : ""}${settings.steering ? ` hint="${settings.steering}"` : ""}`,
        onSelect: () => {
          api.ui.dialog.clear()
          runRetitle(api, sessionID, settings)
        },
      },
      {
        title: "Use defaults",
        value: "reset",
        category: "Run",
        description: "Reset to defaults and run",
        onSelect: () => {
          const defaults: RetitleSettings = { samples: 10, offset: 0, fromPct: 100, steering: "" }
          api.ui.dialog.clear()
          runRetitle(api, sessionID, defaults)
        },
      },
      {
        title: `Samples: ${settings.samples}`,
        value: "samples",
        category: "Adjust",
        description: "Max user turns to sample (3–50)",
        onSelect: () => {
          showNumberPicker(api, "Samples", settings.samples, [3, 5, 10, 15, 20, 30, 50], (v) => {
            settings.samples = v
            showSettingsDialog(api, sessionID, settings)
          })
        },
      },
      {
        title: `Offset: ${settings.offset > 0 ? settings.offset : "all"}`,
        value: "offset",
        category: "Adjust",
        description: "Use only last N messages",
        onSelect: () => {
          showNumberPicker(api, "Offset", settings.offset, [0, 10, 20, 30, 50, 100], (v) => {
            settings.offset = v
            showSettingsDialog(api, sessionID, settings)
          }, "0 = all messages")
        },
      },
      {
        title: `From: ${settings.fromPct}%`,
        value: "from",
        category: "Adjust",
        description: "Sampling center point (0–100, 100=end)",
        onSelect: () => {
          showNumberPicker(api, "From %", settings.fromPct, [0, 25, 50, 75, 100], (v) => {
            settings.fromPct = v
            showSettingsDialog(api, sessionID, settings)
          })
        },
      },
      {
        title: `Hint: ${settings.steering || "(none)"}`,
        value: "hint",
        category: "Adjust",
        description: "Steering hint for the title model",
        onSelect: () => {
          api.ui.dialog.replace(() =>
            api.ui.DialogPrompt({
              title: "Steering hint",
              value: settings.steering,
              placeholder: "e.g. focus on the Docker deployment work",
              onConfirm: (value: string) => {
                settings.steering = value.trim()
                showSettingsDialog(api, sessionID, settings)
              },
              onCancel: () => {
                showSettingsDialog(api, sessionID, settings)
              },
            }),
          )
        },
      },
    ]
    return opts
  }

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Retitle Session",
      skipFilter: true,
      current: "run",
      options: buildOpts(),
    }),
  )
}

function showNumberPicker(
  api: TuiPluginApi,
  title: string,
  current: number,
  choices: number[],
  onPick: (v: number) => void,
  description?: string,
) {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title,
      skipFilter: true,
      current,
      options: choices.map((v) => ({
        title: String(v),
        value: String(v),
        description: v === current ? "← current" : description,
        onSelect: () => {
          onPick(v)
        },
      })),
    }),
  )
}

// ─── Plugin entry point ───────────────────────────────────────────────────────

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "session.retitle",
        title: "Retitle Session (Recent)",
        desc: "Retitle session from recent messages. Args: [hint], --samples N, --from P%, --offset N",
        category: "Session",
        slashName: "retitle",
        run: () => {
          const route = api.route.current
          const sessionID =
            route.name === "session" && typeof route.params?.sessionID === "string"
              ? route.params.sessionID
              : undefined
          if (!sessionID) return
          const settings: RetitleSettings = { samples: 10, offset: 0, fromPct: 100, steering: "" }
          showSettingsDialog(api, sessionID, settings)
        },
      },
    ],
  })
}

export default { id: "opencode-retitle", tui } as TuiPluginModule & { id: string }
