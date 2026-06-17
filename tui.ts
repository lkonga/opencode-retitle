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

function textFromParts(parts: Array<Part>): string | undefined {
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

function sampleTurns(messages: ReadonlyArray<MessageWithParts>, options?: SamplingOptions): SampledMessage[] {
  const baseMessages = options?.offset !== undefined ? messages.slice(-options.offset) : messages
  const userTurns = (baseMessages as Array<MessageWithParts>)
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.info?.role === "user" && textFromParts(message.parts))

  if (userTurns.length === 0) return []

  const MAX_SAMPLES = options?.maxSamples ?? 10
  const TAIL = 3

  let windowStart: number
  let windowLen: number

  if (options?.offset !== undefined) {
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
    const spreadEnd = userTurns.length - TAIL
    const spreadLen = spreadEnd - windowStart
    for (let i = 0; i < spreadCount; i++) {
      const idx = windowStart + Math.round((i * (spreadLen - 1)) / (spreadCount - 1))
      sampleIndices.add(idx)
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
    .replace(/racuse[\s\S]*?<\/think>\s*/g, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^"(.*)"$/, "$1")
    .trim()
  if (!cleaned || cleaned.includes("can't assist with that")) return undefined
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

function parseModelString(input: string): { providerID: string; modelID: string } | undefined {
  const slash = input.indexOf("/")
  if (slash <= 0 || slash >= input.length - 1) return undefined
  return { providerID: input.slice(0, slash), modelID: input.slice(slash + 1) }
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

  const model = pickSessionModel(messages, api.state.provider, api.state.config.small_model)
  if (!model) throw new Error("Connect a provider before using /retitle")
  retitleLog("model-selected", { sessionID, providerID: model.providerID, modelID: model.modelID })

  const childResp = await api.client.session.create({ parentID: sessionID, title: "Retitle generation" })
  if (childResp.error) throw new Error("Failed to create retitle helper session")
  const childID = childResp.data!.id
  retitleLog("helper-created", { sessionID, helperSessionID: childID })

  await api.client.session.prompt({
    sessionID: childID,
    noReply: false,
    agent: "title",
    model,
    parts: [{ type: "text", text: titlePrompt(sampled, steeringHint), synthetic: true }],
  })
  retitleLog("prompt-started", { sessionID, helperSessionID: childID })

  return waitForGeneratedTitle(api, childID)
}

async function retitleSession(api: TuiPluginApi, sessionID: string, rawArgs?: string) {
  api.ui.toast({ variant: "info", title: "Retitle", message: "Analyzing recent messages...", duration: 2500 })
  const title = await generateRetitle(api, sessionID, rawArgs)
  if (!title) {
    retitleLog("no-title", { sessionID })
    api.ui.toast({
      variant: "warning",
      title: "Retitle",
      message: "Unable to generate a title from this conversation",
      duration: 5000,
    })
    return
  }

  const updateResult = await api.client.session.update({ sessionID, title })
  if (updateResult.error) {
    retitleLog("update-error", { sessionID, error: String(updateResult.error) })
    api.ui.toast({ variant: "error", title: "Retitle", message: "Failed to update session title", duration: 5000 })
    return
  }
  retitleLog("updated", { sessionID, titleLength: title.length })
  api.ui.toast({ variant: "success", title: "Retitle", message: "New title: " + title, duration: 6000 })
}

function askArgs(api: TuiPluginApi, sessionID: string) {
  const options = [
    {
      title: "Retitle with defaults",
      value: "default",
      description: "Tail-3 sampling, 10 max samples, no hint",
    },
    {
      title: "Retitle — last 20 messages",
      value: "offset20",
      description: "--offset 20",
    },
    {
      title: "Retitle — last 50 messages",
      value: "offset50",
      description: "--offset 50",
    },
    {
      title: "Retitle — broad sample (20 turns)",
      value: "broad",
      description: "--samples 20 --from 50",
    },
    {
      title: "Retitle — with hint…",
      value: "hint",
      description: "Enter a custom steering hint",
    },
  ]

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Retitle Session",
      options,
      current: "default",
      onSelect: (opt: { title: string; value: string }) => {
        if (opt.value === "hint") {
          api.ui.dialog.replace(() =>
            api.ui.DialogPrompt({
              title: "Retitle — Steering Hint",
              placeholder: "e.g. focus on the Docker deployment work",
              onConfirm: (value: string) => {
                api.ui.dialog.clear()
                retitleSession(api, sessionID, value).catch((error) => {
                  retitleLog("error", { sessionID, message: error instanceof Error ? error.message : String(error) })
                  api.ui.toast({
                    variant: "error",
                    title: "Retitle failed",
                    message: error instanceof Error ? error.message : String(error),
                    duration: 7000,
                  })
                })
              },
              onCancel: () => {
                api.ui.dialog.clear()
                askArgs(api, sessionID)
              },
            }),
          )
        } else {
          api.ui.dialog.clear()
          const argMap: Record<string, string> = {
            default: "",
            offset20: "--offset 20",
            offset50: "--offset 50",
            broad: "--samples 20 --from 50",
          }
          retitleSession(api, sessionID, argMap[opt.value] || "").catch((error) => {
            retitleLog("error", { sessionID, message: error instanceof Error ? error.message : String(error) })
            api.ui.toast({
              variant: "error",
              title: "Retitle failed",
              message: error instanceof Error ? error.message : String(error),
              duration: 7000,
            })
          })
        }
      },
    }),
  )
}

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
          askArgs(api, sessionID)
        },
      },
    ],
  })
}

export default { id: "opencode-retitle", tui } as TuiPluginModule & { id: string }
