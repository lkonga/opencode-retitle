/** @jsxImportSource @opentui/solid */
// OpenCode V2 TUI plugin — /retitle
//
// Public V2 TUI plugin API only (`@opencode/plugin/tui`):
//   * `Plugin.define({ id, setup })`            src/tui/plugin.ts
//   * `context.ui.slot(claim)`                  src/tui/context.ts (UI.slot)
//   * `context.keymap.layer(() => KeymapLayer)` src/tui/context.ts (Keymap.layer)
//   * `context.ui.dialog.{select,prompt}`       src/tui/context.ts (Dialog)
//   * `context.ui.toast.show(...)`              src/tui/context.ts (Toast)
//   * `context.ui.router.current()`             src/tui/context.ts (UI.router)
//   * `context.client` / `context.data`         src/tui/context.ts (Context)
//
// The V1 entrypoint (`../tui.ts`) is untouched and keeps loading under V1.

import fs from "node:fs"
import { Plugin } from "@opencode/plugin/tui"
import {
  buildModelOptions,
  cleanTitle,
  isModelAvailable,
  latestAssistantError,
  latestAssistantText,
  modelKey,
  normalizeMessages,
  parseRetitleArgs,
  pickModel,
  sampleTurns,
  settingsToArgs,
  titlePrompt,
  type ModelRef,
  type RawSessionMessage,
  type RetitleMessage,
  type RetitleSettings,
} from "./retitle-core"
import { readRetitleConfig, writeRetitleConfigVal } from "./config"

type Ctx = Plugin.Context

const TITLE_AGENT = "title"
const MESSAGE_FETCH_LIMIT = 200
/** 24 * 500ms = 12s hard cap, matching V1. */
const TITLE_POLL_ATTEMPTS = 24
const FAIL_TOAST_DEBOUNCE_MS = 15 * 60 * 1000

let lastFailToastAt = 0
let lastFailToastKey = ""
let retitleInFlight = false

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retitleLog(event: string, data: Record<string, unknown> = {}): void {
  try {
    fs.appendFileSync(
      process.env.OPENCODE_RETITLE_LOG || "/tmp/opencode-retitle.log",
      JSON.stringify({ ts: new Date().toISOString(), source: "v2", event, ...data }) + "\n",
    )
  } catch {}
}

function defaultSettings(): RetitleSettings {
  const persisted = readRetitleConfig()
  return {
    samples: 10,
    offset: 0,
    fromPct: 100,
    steering: "",
    model: typeof persisted.model === "string" ? persisted.model : "",
  }
}

async function ensureCatalog(context: Ctx): Promise<void> {
  if ((context.data.location.model.list() ?? []).length === 0) {
    await context.data.location.model.sync().catch(() => {})
  }
  if ((context.data.location.provider.list() ?? []).length === 0) {
    await context.data.location.provider.sync().catch(() => {})
  }
  if ((context.data.location.agent.list() ?? []).length === 0) {
    await context.data.location.agent.sync().catch(() => {})
  }
}

/** V1 `small_model` is migrated to the built-in `title` agent's model in V2. */
function titleAgentModel(context: Ctx): ModelRef | undefined {
  const agents = context.data.location.agent.list() ?? []
  const title = agents.find((agent) => agent.id === TITLE_AGENT)
  const model = title?.model
  if (!model?.id || !model.providerID) return undefined
  return { providerID: model.providerID, modelID: model.id, ...(model.variant ? { variant: model.variant } : {}) }
}

function describeModel(context: Ctx, override: string): string {
  if (override.trim()) return override.trim()
  const agent = titleAgentModel(context)
  if (agent) return modelKey(agent)
  return "auto"
}

function toastFailure(context: Ctx, key: string, message: string, variant: "warning" | "error" = "warning"): void {
  const now = Date.now()
  if (key === lastFailToastKey && now - lastFailToastAt < FAIL_TOAST_DEBOUNCE_MS) {
    retitleLog("fail-toast-debounced", { key, message })
    return
  }
  lastFailToastKey = key
  lastFailToastAt = now
  context.ui.toast.show({ variant, title: "Retitle", message, duration: 6000 })
}

async function fetchMessages(context: Ctx, sessionID: string): Promise<RetitleMessage[]> {
  try {
    const response = await context.client.message.list({
      sessionID,
      limit: MESSAGE_FETCH_LIMIT,
      order: "desc",
    })
    const data = (response as { data?: ReadonlyArray<RawSessionMessage> } | undefined)?.data ?? []
    const messages = normalizeMessages([...data].reverse())
    if (messages.length > 0) return messages
  } catch (error) {
    retitleLog("messages-fetch-error", { sessionID, error: String(error) })
  }
  await context.data.session.message.sync(sessionID).catch(() => {})
  return normalizeMessages(context.data.session.message.list(sessionID) as ReadonlyArray<RawSessionMessage>)
}

/**
 * Primary path: V2 `session.generate` — transient text generation from a
 * Session's context (`src/session/generate.ts`, `server/handlers/session.ts`).
 * The helper Session is created with the `title` agent and the resolved model,
 * so the generation runs with the title system prompt and no user history.
 *
 * Fallback (only when `session.generate` is absent): queue a prompt and poll
 * the projected messages, matching the V1 helper-session flow.
 */
async function generateText(context: Ctx, sessionID: string, prompt: string): Promise<string | undefined> {
  const sessionApi = context.client.session as typeof context.client.session & {
    generate?: (input: { sessionID: string; prompt: string }) => Promise<{ text?: string } | undefined>
  }

  if (typeof sessionApi.generate === "function") {
    const result = await sessionApi.generate({ sessionID, prompt })
    const value = typeof result?.text === "string" ? result.text : ""
    if (value.trim()) return value
    return undefined
  }

  await context.client.session.prompt({ sessionID, text: prompt })
  for (let attempt = 0; attempt < TITLE_POLL_ATTEMPTS; attempt++) {
    const response = await context.client.message.list({ sessionID, limit: 50, order: "desc" })
    const messages = normalizeMessages(
      [...((response as { data?: ReadonlyArray<RawSessionMessage> } | undefined)?.data ?? [])].reverse(),
    )
    const error = latestAssistantError(messages)
    if (error) throw new Error(error)
    const value = latestAssistantText(messages)
    if (value && value.trim()) return value
    await delay(500)
  }
  retitleLog("title-timeout", { helperSessionID: sessionID, attempts: TITLE_POLL_ATTEMPTS })
  return undefined
}

async function generateRetitle(
  context: Ctx,
  sessionID: string,
  settings: RetitleSettings,
): Promise<string | undefined> {
  retitleLog("start", { sessionID, modelOverride: settings.model || "" })
  const { steeringHint, samplingOptions } = parseRetitleArgs(settingsToArgs(settings))

  const messages = await fetchMessages(context, sessionID)
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

  await ensureCatalog(context)
  const available = context.data.location.model.list() ?? []
  const agentModel = titleAgentModel(context)
  const sessionModel = context.data.session.get(sessionID)?.model
  const model = pickModel({
    override: settings.model,
    agentModel: agentModel ? { providerID: agentModel.providerID, id: agentModel.modelID, variant: agentModel.variant } : undefined,
    sessionModel,
    messages,
    available,
  })
  if (!model) throw new Error("Connect a provider before using /retitle")

  // Fail fast when the catalog is loaded and the chosen model is not in it.
  if (available.length > 0 && !isModelAvailable(model, available)) {
    throw new Error(`Model not available: ${modelKey(model)}`)
  }

  retitleLog("model-selected", {
    sessionID,
    providerID: model.providerID,
    modelID: model.modelID,
    source: settings.model ? "settings-override" : agentModel ? "title-agent" : "fallback",
  })

  const helper = await context.client.session.create({
    title: "Retitle generation",
    agent: TITLE_AGENT,
    model: {
      id: model.modelID,
      providerID: model.providerID,
      ...(model.variant ? { variant: model.variant } : {}),
    },
    ...(context.location ? { location: context.location } : {}),
  })
  const helperID = helper?.id
  if (!helperID) throw new Error("Failed to create retitle helper session")
  retitleLog("helper-created", { sessionID, helperSessionID: helperID })

  try {
    const raw = await generateText(context, helperID, titlePrompt(sampled, steeringHint))
    const title = raw ? cleanTitle(raw) : undefined
    if (title) retitleLog("title-ready", { helperSessionID: helperID, titleLength: title.length })
    return title
  } finally {
    await context.client.session.remove({ sessionID: helperID }).catch(() => {})
  }
}

async function applyTitle(context: Ctx, sessionID: string, title: string): Promise<boolean> {
  try {
    await context.client.session.rename({ sessionID, title })
  } catch (error) {
    retitleLog("update-error", { sessionID, error: String(error) })
    context.ui.toast.show({ variant: "error", title: "Retitle", message: "Failed to update session title", duration: 5000 })
    return false
  }
  retitleLog("updated", { sessionID, titleLength: title.length })
  context.ui.toast.show({ variant: "success", title: "Retitle", message: "New title: " + title, duration: 6000 })
  return true
}

// ─── Confirm flow: Apply / Edit / Regenerate / Cancel ─────────────────────────

async function confirmMenu(context: Ctx, sessionID: string, title: string, settings: RetitleSettings): Promise<void> {
  const action = await context.ui.dialog.select<string>({
    title: `Retitle — "${title}"`,
    current: "apply",
    options: [
      { title: "Apply", value: "apply", description: "Set this as the session title" },
      { title: "Edit…", value: "edit", description: "Modify the title before applying" },
      { title: "Regenerate", value: "regenerate", description: "Run again with different settings" },
      { title: "Cancel", value: "cancel", description: "Discard this title" },
    ],
  })

  if (action === "apply") {
    await applyTitle(context, sessionID, title)
    return
  }
  if (action === "edit") {
    const edited = await context.ui.dialog.prompt({ title: "Edit title", value: title, placeholder: "Session title" })
    const trimmed = (edited ?? "").trim()
    if (!trimmed) {
      await confirmMenu(context, sessionID, title, settings)
      return
    }
    await applyTitle(context, sessionID, trimmed)
    return
  }
  if (action === "regenerate") {
    await settingsDialog(context, sessionID, settings)
  }
}

// ─── Generation runner ────────────────────────────────────────────────────────

async function runRetitle(context: Ctx, sessionID: string, settings: RetitleSettings): Promise<void> {
  if (retitleInFlight) {
    retitleLog("already-running", { sessionID })
    toastFailure(context, "in-flight", "Retitle already running", "warning")
    return
  }
  retitleInFlight = true
  const modelLabel = describeModel(context, settings.model)
  let reopenSettings = false

  try {
    const title = await generateRetitle(context, sessionID, settings)
    if (!title) {
      retitleLog("no-title", { sessionID, model: modelLabel })
      toastFailure(
        context,
        `no-title:${modelLabel}`,
        `No title from ${modelLabel}. Pick another model in settings.`,
        "warning",
      )
      reopenSettings = true
    } else {
      await confirmMenu(context, sessionID, title, settings)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    retitleLog("error", { sessionID, model: modelLabel, message })
    toastFailure(context, `error:${modelLabel}:${message.slice(0, 80)}`, message, "error")
    reopenSettings = true
  } finally {
    retitleInFlight = false
  }

  if (reopenSettings) await settingsDialog(context, sessionID, settings)
}

// ─── Composable settings dialog ───────────────────────────────────────────────

async function settingsDialog(context: Ctx, sessionID: string, settings: RetitleSettings): Promise<void> {
  for (;;) {
    const agentModel = titleAgentModel(context)
    const agentLabel = agentModel ? modelKey(agentModel) : undefined
    const modelDisplay = settings.model || (agentLabel ? `agent title ${agentLabel}` : "auto")
    const effective = settings.model || agentLabel || "auto"

    const action = await context.ui.dialog.select<string>({
      title: "Retitle Session",
      current: "run",
      options: [
        {
          title: "Retitle with current settings",
          value: "run",
          category: "Run",
          description: `model=${effective} samples=${settings.samples}${settings.offset > 0 ? ` offset=${settings.offset}` : ""}${settings.fromPct !== 100 ? ` from=${settings.fromPct}%` : ""}${settings.steering ? ` hint="${settings.steering}"` : ""}`,
        },
        {
          title: "Use defaults",
          value: "reset",
          category: "Run",
          description: "Reset sampling/hint defaults and run (keeps saved model)",
        },
        {
          title: `Model: ${modelDisplay}`,
          value: "model",
          category: "Adjust",
          description: "LLM for title generation (saved in retitle-config.json)",
        },
        {
          title: `Samples: ${settings.samples}`,
          value: "samples",
          category: "Adjust",
          description: "Max user turns to sample (3–50)",
        },
        {
          title: `Offset: ${settings.offset > 0 ? settings.offset : "all"}`,
          value: "offset",
          category: "Adjust",
          description: "Use only last N messages",
        },
        {
          title: `From: ${settings.fromPct}%`,
          value: "from",
          category: "Adjust",
          description: "Sampling center point (0–100, 100=end)",
        },
        {
          title: `Hint: ${settings.steering || "(none)"}`,
          value: "hint",
          category: "Adjust",
          description: "Steering hint for the title model",
        },
      ],
    })

    if (action === undefined) return

    if (action === "run") {
      await runRetitle(context, sessionID, settings)
      return
    }

    if (action === "reset") {
      settings.samples = 10
      settings.offset = 0
      settings.fromPct = 100
      settings.steering = ""
      await runRetitle(context, sessionID, settings)
      return
    }

    if (action === "model") {
      const picked = await modelPicker(context, settings.model)
      if (picked !== undefined) settings.model = picked
      continue
    }

    if (action === "samples") {
      const picked = await numberPicker(context, "Samples", settings.samples, [3, 5, 10, 15, 20, 30, 50])
      if (picked !== undefined) settings.samples = picked
      continue
    }

    if (action === "offset") {
      const picked = await numberPicker(context, "Offset", settings.offset, [0, 10, 20, 30, 50, 100], "0 = all messages")
      if (picked !== undefined) settings.offset = picked
      continue
    }

    if (action === "from") {
      const picked = await numberPicker(context, "From %", settings.fromPct, [0, 25, 50, 75, 100])
      if (picked !== undefined) settings.fromPct = picked
      continue
    }

    if (action === "hint") {
      const picked = await context.ui.dialog.prompt({
        title: "Steering hint",
        value: settings.steering,
        placeholder: "e.g. focus on the Docker deployment work",
      })
      if (picked !== undefined) settings.steering = picked.trim()
      continue
    }
  }
}

async function modelPicker(context: Ctx, current: string): Promise<string | undefined> {
  await ensureCatalog(context)
  const options = buildModelOptions(
    context.data.location.model.list() ?? [],
    context.data.location.provider.list() ?? [],
    current,
  )
  const picked = await context.ui.dialog.select<string>({
    title: "Retitle model",
    placeholder: "Search models...",
    current,
    options: [...options, { title: "← Back", value: "__back__", category: "Navigation" }],
  })

  if (picked === undefined) return undefined
  if (picked === "__back__") return current

  writeRetitleConfigVal("model", picked)
  context.ui.toast.show({
    variant: "success",
    title: "Retitle",
    message: picked ? `Model: ${picked}` : "Model: agent title / auto",
    duration: 4000,
  })
  return picked
}

async function numberPicker(
  context: Ctx,
  title: string,
  current: number,
  choices: ReadonlyArray<number>,
  description?: string,
): Promise<number | undefined> {
  const picked = await context.ui.dialog.select<string>({
    title,
    current: String(current),
    options: choices.map((value) => ({
      title: String(value),
      value: String(value),
      description: value === current ? "← current" : description,
    })),
  })
  if (picked === undefined) return undefined
  const parsed = Number(picked)
  return Number.isFinite(parsed) ? parsed : undefined
}

// ─── Plugin entry point ───────────────────────────────────────────────────────

async function openRetitle(context: Ctx, rawArgs: string): Promise<void> {
  const route = context.ui.router.current()
  const sessionID = route?.type === "session" ? route.sessionID : undefined
  if (!sessionID) {
    retitleLog("no-session", { route: route?.type ?? "unknown" })
    context.ui.toast.show({
      variant: "warning",
      title: "Retitle",
      message: "Open a session before using /retitle",
      duration: 5000,
    })
    return
  }

  const settings = defaultSettings()
  const parsed = parseRetitleArgs(rawArgs)
  if (parsed.steeringHint) settings.steering = parsed.steeringHint
  if (parsed.samplingOptions?.maxSamples !== undefined) settings.samples = parsed.samplingOptions.maxSamples
  if (parsed.samplingOptions?.offset !== undefined) settings.offset = parsed.samplingOptions.offset
  if (parsed.samplingOptions?.fromPercent !== undefined) settings.fromPct = parsed.samplingOptions.fromPercent

  await ensureCatalog(context)
  await settingsDialog(context, sessionID, settings)
}

function Commands(props: { context: Ctx }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "retitle.session.retitle",
        title: "Retitle Session (Recent)",
        description: "Retitle session from recent messages. Args: [hint], --samples N, --from P%, --offset N",
        group: "Session",
        palette: true,
        slash: { name: "retitle", arguments: true },
        run: (input?: string) => {
          void openRetitle(props.context, input ?? "")
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "opencode-retitle-v2-tui",
  setup: (context) => context.ui.slot({ append: "app", render: () => <Commands context={context} /> }),
})
