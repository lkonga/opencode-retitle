// End-to-end command tests: single registration, no duplicate runs, and the
// full lifecycle from slash/palette invocation to the title write.

import { describe, expect, test } from "bun:test"
import { createRetitleAdapter } from "../adapter"
import {
  RETITLE_BIND,
  RETITLE_COMMAND_ID,
  RETITLE_SLASH_NAME,
  createRetitleCommand,
  retitleKeymapLayer,
} from "../command"
import { RetitleTimeoutError } from "../deadline"
import { openRetitle } from "../dialogs"
import { PROGRESS_APPLYING, PROGRESS_GENERATING } from "../progress"
import type { RetitleLogger } from "../logger"
import { fakeCatalog, fakeClient, fakeContext, fakeProgress, fakeUi, fakeUiAtHome, recordingLogger, userMessage } from "./fake"
import type { SessionApiClient } from "../session-api"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Yields microtasks until `until()` holds (or the bound is hit). Deterministic: no timers. */
async function drainUntil(until: () => boolean, limit = 100): Promise<void> {
  for (let index = 0; index < limit && !until(); index++) await Promise.resolve()
}

function setup(options: {
  readonly ui: ReturnType<typeof fakeUi>
  readonly client?: ReturnType<typeof fakeClient>
  readonly messages?: Array<unknown>
  readonly catalog?: ReturnType<typeof fakeCatalog>
  readonly refresh?: "ok" | "reject" | "unsupported"
  readonly logger?: RetitleLogger
}) {
  const client = options.client ?? fakeClient({ list: () => ({ data: options.messages ?? [userMessage("hello")], cursor: {} }) })
  const context = fakeContext({
    client: client.client,
    catalog: options.catalog ?? fakeCatalog({ models: [{ id: "gpt-5", providerID: "openai" }] }),
    messages: options.messages ?? [userMessage("hello")],
    ...(options.refresh ? { refresh: options.refresh } : {}),
  })
  const progress = fakeProgress()
  const adapter = createRetitleAdapter(context, {
    logger: options.logger ?? { event: () => {} },
    progressSurface: progress.surface,
  })
  return { client, context, adapter, ui: options.ui, progress }
}

describe("command registration", () => {
  test("registers exactly one command that is both a slash command and a palette command", () => {
    const layer = retitleKeymapLayer(() => {})
    expect(layer.mode).toBe("global")
    expect(layer.commands).toHaveLength(1)

    const [command] = layer.commands
    expect(command.id).toBe(RETITLE_COMMAND_ID)
    expect(command.palette).toBe(true)
    expect(command.slash).toEqual({ name: RETITLE_SLASH_NAME, arguments: true })
  })

  test("carries a raw binding alongside the palette and slash reachability", () => {
    const layer = retitleKeymapLayer(() => {})

    // The runtime's layer builder validates the entry shape: an entry with an
    // `id`, `palette` and `slash` is a *named* command, while an entry without
    // an `id` may only carry `bind` ("Inline keymap commands require bind",
    // "Palette commands require an ID"). Both together are what makes this one
    // reachable command that also owns a key stroke, not an inline shortcut.
    expect(layer.commands).toHaveLength(1)
    const [command] = layer.commands
    expect(typeof command.id).toBe("string")
    expect(command.palette).toBe(true)
    expect(command.slash).toBeDefined()
    expect(typeof command.bind).toBe("string")
    expect(command.bind).toBe(RETITLE_BIND)
  })

  test("binds one fixed stroke that no other command in the layer claims", () => {
    const layer = retitleKeymapLayer(() => {})
    const strokes = layer.commands.flatMap((command) =>
      typeof command.bind === "string" ? command.bind.split(",").map((stroke) => stroke.trim()) : [],
    )

    // A single stroke: the command fires on its own key, not on a sequence it
    // shares with another command.
    expect(RETITLE_BIND).toBe("ctrl+shift+r")
    expect(RETITLE_BIND.includes(",")).toBe(false)
    expect(strokes).toEqual([RETITLE_BIND])
    expect(new Set(strokes).size).toBe(strokes.length)
  })

  test("delivers the raw argument string to the handler exactly once per invocation", async () => {
    const seen: string[] = []
    const command = createRetitleCommand((rawArgs) => {
      seen.push(rawArgs)
    })

    command.run("--samples 20 docker setup")
    command.run()

    await Promise.resolve()
    expect(seen).toEqual(["--samples 20 docker setup", ""])
  })

  test("contains a handler failure instead of rejecting into the keymap", async () => {
    const errors: unknown[] = []
    const command = createRetitleCommand(
      () => {
        throw new Error("boom")
      },
      (error) => errors.push(error),
    )

    expect(() => command.run()).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toHaveLength(1)
  })

  test("refuses to run without a session and never claims the run gate", async () => {
    const ui = fakeUiAtHome()
    const { adapter } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(adapter.gate.running()).toBe(false)
    expect(ui.toasts).toEqual([{ variant: "warning", message: "Open a session before using /retitle" }])
  })
})

describe("run lifecycle", () => {
  test("applies the generated title once and cleans the helper up", async () => {
    const ui = fakeUi({ select: ["run", "apply"] })
    const { adapter, client } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.generates).toHaveLength(1)
    expect(client.calls.removes).toEqual(["ses_helper"])
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(ui.toasts.some((toast) => toast.message === "New title: Generated title")).toBe(true)
    expect(adapter.gate.running()).toBe(false)
  })

  test("sends the bounded sampled prompt to the helper session only", async () => {
    // A 400-turn history with very long turns: the prompt must be the sampled
    // subset, and it must never be sent to the session being retitled. The
    // client returns the page newest-first (`order: "desc"`), exactly as the
    // runtime does.
    const oldestFirst: Array<unknown> = []
    for (let index = 0; index < 400; index++) {
      oldestFirst.push({ type: "user", text: `turn ${index} ${"x".repeat(500)}` })
      oldestFirst.push({ type: "assistant", content: [{ type: "text", text: `answer ${index}` }] })
    }
    const page = [...oldestFirst].reverse()
    const ui = fakeUi({ select: ["run", "cancel"] })
    const client = fakeClient({ list: () => ({ data: page, cursor: {} }) })
    const { adapter } = setup({ ui, client, messages: oldestFirst })

    await openRetitle(ui, adapter, "--samples 5")

    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.generates).toHaveLength(1)
    const [generation] = client.calls.generates
    expect(generation.sessionID).toBe("ses_helper")
    expect(generation.sessionID).not.toBe("ses_current")
    // The current session is only ever read (message.list) and, on Apply,
    // written (session.rename) — never prompted.
    expect(client.calls.lists.map((call) => call.sessionID)).toEqual(["ses_current"])
    expect(client.calls.renames).toEqual([])
    expect(generation.prompt).toContain("turn 399")
    expect(generation.prompt.split("[Turn ").length - 1).toBeLessThanOrEqual(10)
    expect(generation.prompt.length).toBeLessThan(5_000)
    expect(generation.prompt).not.toContain("x".repeat(500))
    expect(client.calls.removes).toEqual(["ses_helper"])
  })

  test("gives the fresh helper the fallback model when the configured title model is stale", async () => {
    // The live deployment shape: `agents.title.model` is inherited from V1 and
    // points at a provider this runtime does not carry. The run must still work,
    // with the fallback resolved by the chain, and the prompt must still go to a
    // fresh helper session pinned to the `title` agent.
    const logged: Array<{ name: string; fields: Record<string, unknown> }> = []
    const ui = fakeUi({ select: ["run", "apply"] })
    const client = fakeClient({ list: () => ({ data: [userMessage("hello")], cursor: {} }) })
    const context = fakeContext({
      client: client.client,
      catalog: fakeCatalog({
        models: [{ id: "session-model", providerID: "session" }],
        agents: [{ id: "title", model: { id: "9r-xai-grok-4.5-low", providerID: "9router" } }],
      }),
      sessionModel: { id: "session-model", providerID: "session" },
      messages: [userMessage("hello")],
    })
    const adapter = createRetitleAdapter(context, {
      logger: { event: (name, fields = {}) => void logged.push({ name, fields: fields as Record<string, unknown> }) },
    })

    await openRetitle(ui, adapter, "")

    expect(client.calls.creates).toEqual([
      {
        title: "Retitle generation",
        agent: "title",
        model: { id: "session-model", providerID: "session" },
        location: { directory: "/workspace/default" },
      },
    ])
    expect(client.calls.generates).toHaveLength(1)
    expect(client.calls.generates[0].sessionID).toBe("ses_helper")
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])

    // The log explains the choice with metadata only — no transcript, prompt or title.
    expect(logged.find((event) => event.name === "model-selected")?.fields).toMatchObject({
      providerID: "session",
      modelID: "session-model",
      modelSource: "session",
      skippedModelCount: 1,
    })
    expect(logged.find((event) => event.name === "title-agent-model-unavailable")?.fields).toMatchObject({
      providerID: "9router",
      modelID: "9r-xai-grok-4.5-low",
    })
    expect(JSON.stringify(logged)).not.toContain("hello")
    expect(JSON.stringify(logged)).not.toContain("Generated title")
  })

  test("applies an edited title instead of the generated one", async () => {
    const ui = fakeUi({ select: ["run", "edit"], prompt: ["  My edited title  "] })
    const { adapter, client } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "My edited title" }])
  })

  test("writes nothing when the candidate is cancelled", async () => {
    const ui = fakeUi({ select: ["run", "cancel"] })
    const { adapter, client } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(client.calls.renames).toEqual([])
    expect(adapter.gate.running()).toBe(false)
  })

  test("discards an empty edit rather than writing an empty title", async () => {
    const ui = fakeUi({ select: ["run", "edit"], prompt: ["   "] })
    const { adapter, client } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(client.calls.renames).toEqual([])
  })

  test("regenerate reopens the settings dialog and reuses the gate", async () => {
    let call = 0
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => {
        call += 1
        return { text: `Title ${call}` }
      },
    })
    const ui = fakeUi({ select: ["run", "regenerate", "run", "apply"] })
    const { adapter } = setup({ ui, client })

    await openRetitle(ui, adapter, "")

    expect(client.calls.generates).toHaveLength(2)
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Title 2" }])
  })

  test("reports an empty session without reopening settings", async () => {
    const ui = fakeUi({ select: ["run"] })
    const client = fakeClient({ list: () => ({ data: [], cursor: {} }) })
    const { adapter } = setup({ ui, client, messages: [] })

    await openRetitle(ui, adapter, "")

    expect(ui.selects).toHaveLength(1)
    expect(ui.toasts.some((toast) => toast.message.startsWith("Nothing to retitle yet"))).toBe(true)
    expect(client.calls.renames).toEqual([])
  })

  test("surfaces a provider failure and reopens settings for another attempt", async () => {
    const ui = fakeUi({ select: ["run", "run", undefined] })
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => {
        throw new Error("provider 502")
      },
    })
    const { adapter } = setup({ ui, client })

    await openRetitle(ui, adapter, "")

    // Settings, failure -> settings again, failure -> dismissed.
    expect(ui.selects).toHaveLength(3)
    expect(ui.selects.map((select) => select.title)).toEqual(["Retitle Session", "Retitle Session", "Retitle Session"])
    expect(ui.toasts.some((toast) => toast.variant === "error")).toBe(true)
    expect(client.calls.renames).toEqual([])
    expect(adapter.gate.running()).toBe(false)
  })

  test("persists a model chosen in the settings dialog", async () => {
    const ui = fakeUi({ select: ["model", "openai/gpt-5", "run", "cancel"] })
    const { adapter } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(adapter.settings.read()).toEqual({ model: "openai/gpt-5" })
    expect(ui.selects[1].title).toBe("Retitle model")
  })

  test("releases the gate when a dialog fails", async () => {
    const ui = fakeUi({})
    ui.ui = {
      ...ui.ui,
      dialog: {
        ...ui.ui.dialog,
        select: () => Promise.reject(new Error("dialog exploded")),
      },
    }
    const { adapter, client } = setup({ ui })

    await expect(openRetitle(ui, adapter, "")).rejects.toThrow("dialog exploded")

    expect(adapter.gate.running()).toBe(false)
    expect(client.calls.creates).toEqual([])
  })
})

describe("duplicate suppression", () => {
  test("a second invocation in the same tick is rejected while the first is in flight", async () => {
    const gate = deferred<{ text: string }>()
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => gate.promise,
    })
    const ui = fakeUi({ select: ["run", "apply"] })
    const { adapter } = setup({ ui, client })

    const first = openRetitle(ui, adapter, "")
    const second = openRetitle(ui, adapter, "")

    await second
    expect(adapter.gate.running()).toBe(true)
    expect(ui.toasts.some((toast) => toast.message === "Retitle already running")).toBe(true)

    gate.resolve({ text: "Generated title" })
    await first

    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.generates).toHaveLength(1)
    expect(client.calls.renames).toHaveLength(1)
    expect(adapter.gate.running()).toBe(false)
  })

  test("a rapid re-invocation after completion is debounced by the gate", async () => {
    const ui = fakeUi({ select: ["run", "cancel"] })
    const { adapter, client } = setup({ ui })

    await openRetitle(ui, adapter, "")
    // Same tick-adjacent re-entry: the gate's debounce window is measured from
    // the previous claim, so this one is dropped before it can open a dialog.
    expect(adapter.gate.begin()).toEqual({ ok: false, reason: "debounced" })

    await openRetitle(ui, adapter, "")

    // Only the first run reached the settings dialog and the confirm menu.
    expect(ui.selects).toHaveLength(2)
    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.generates).toHaveLength(1)
  })

  test("a later invocation is accepted once the window has passed", async () => {
    let now = 0
    const ui = fakeUi({ select: ["run", "cancel", "run", "cancel"] })
    const client = fakeClient({ list: () => ({ data: [userMessage("hello")], cursor: {} }) })
    const context = fakeContext({
      client: client.client,
      catalog: fakeCatalog({ models: [{ id: "gpt-5", providerID: "openai" }] }),
      messages: [userMessage("hello")],
    })
    const adapter = createRetitleAdapter(context, { logger: { event: () => {} }, now: () => now })

    await openRetitle(ui, adapter, "")
    now += 5_000
    await openRetitle(ui, adapter, "")

    expect(ui.selects).toHaveLength(4)
    expect(client.calls.creates).toHaveLength(2)
  })
})

describe("progress feedback", () => {
  test("shows generation then apply progress, clearing each in turn", async () => {
    const ui = fakeUi({ select: ["run", "apply"] })
    const { adapter, progress } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(progress.events).toEqual([
      { kind: "set", message: PROGRESS_GENERATING },
      { kind: "clear" },
      { kind: "set", message: PROGRESS_APPLYING },
      { kind: "clear" },
    ])
    expect(progress.active()).toBeUndefined()
    expect(PROGRESS_GENERATING).toBe("Generating title…")
    expect(PROGRESS_APPLYING).toBe("Applying title…")
  })

  test("clears generation progress when the candidate is cancelled", async () => {
    const ui = fakeUi({ select: ["run", "cancel"] })
    const { adapter, progress } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(progress.events).toEqual([{ kind: "set", message: PROGRESS_GENERATING }, { kind: "clear" }])
    expect(progress.active()).toBeUndefined()
    expect(ui.toasts.some((toast) => toast.message.startsWith("New title"))).toBe(false)
  })

  test("clears generation progress on a generation timeout and still removes the helper", async () => {
    const ui = fakeUi({ select: ["run", undefined] })
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => {
        throw new RetitleTimeoutError(45_000, "generate")
      },
    })
    const { adapter, progress } = setup({ ui, client })

    await openRetitle(ui, adapter, "")

    expect(progress.active()).toBeUndefined()
    expect(progress.events).toEqual([{ kind: "set", message: PROGRESS_GENERATING }, { kind: "clear" }])
    expect(client.calls.removes).toEqual(["ses_helper"])
    expect(ui.toasts.some((toast) => toast.variant === "error")).toBe(true)
    expect(adapter.gate.running()).toBe(false)
  })

  test("clears generation progress on a provider failure and still removes the helper", async () => {
    const ui = fakeUi({ select: ["run", undefined] })
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => {
        throw new Error("provider 502")
      },
    })
    const { adapter, progress } = setup({ ui, client })

    await openRetitle(ui, adapter, "")

    expect(progress.active()).toBeUndefined()
    expect(client.calls.removes).toEqual(["ses_helper"])
    expect(adapter.gate.running()).toBe(false)
  })

  test("clears apply progress when the write fails, with no refresh and no success toast", async () => {
    const ui = fakeUi({ select: ["run", "apply"] })
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      rename: () => {
        throw new Error("write refused")
      },
    })
    const { adapter, progress, context } = setup({ ui, client })

    await openRetitle(ui, adapter, "")

    expect(progress.events).toEqual([
      { kind: "set", message: PROGRESS_GENERATING },
      { kind: "clear" },
      { kind: "set", message: PROGRESS_APPLYING },
      { kind: "clear" },
    ])
    expect(progress.active()).toBeUndefined()
    expect(context.invalidations).toEqual([])
    expect(context.refreshes).toEqual([])
    expect(ui.toasts.some((toast) => toast.variant === "error")).toBe(true)
    expect(ui.toasts.some((toast) => toast.message.startsWith("New title"))).toBe(false)
  })

  test("clears the surface when a later dialog throws", async () => {
    const ui = fakeUi({ select: ["run", "apply"] })
    let calls = 0
    ui.ui = {
      ...ui.ui,
      dialog: {
        ...ui.ui.dialog,
        select: () => {
          calls += 1
          return calls === 1 ? Promise.resolve("run" as never) : Promise.reject(new Error("confirm exploded"))
        },
      },
    }
    const { adapter, progress } = setup({ ui })

    await expect(openRetitle(ui, adapter, "")).rejects.toThrow("confirm exploded")

    expect(progress.active()).toBeUndefined()
    expect(progress.events).toEqual([{ kind: "set", message: PROGRESS_GENERATING }, { kind: "clear" }])
    expect(adapter.gate.running()).toBe(false)
  })

  test("a rejected duplicate invocation never touches the active run's progress", async () => {
    const generation = deferred<{ text: string }>()
    const ui = fakeUi({ select: ["run", "apply"] })
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => generation.promise,
    })
    const { adapter, progress } = setup({ ui, client })

    const first = openRetitle(ui, adapter, "")
    await drainUntil(() => progress.active() !== undefined)

    const second = openRetitle(ui, adapter, "")
    await second

    // The denied run opened no lane: the first run's surface is still up and the
    // gate is still held.
    expect(adapter.gate.running()).toBe(true)
    expect(progress.active()).toBe(PROGRESS_GENERATING)
    expect(progress.events).toEqual([{ kind: "set", message: PROGRESS_GENERATING }])
    expect(ui.toasts.some((toast) => toast.message === "Retitle already running")).toBe(true)

    generation.resolve({ text: "Generated title" })
    await first

    // One helper, one progress lifecycle, nothing left on screen or in the gate.
    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.generates).toHaveLength(1)
    expect(client.calls.renames).toHaveLength(1)
    expect(progress.events).toEqual([
      { kind: "set", message: PROGRESS_GENERATING },
      { kind: "clear" },
      { kind: "set", message: PROGRESS_APPLYING },
      { kind: "clear" },
    ])
    expect(adapter.gate.running()).toBe(false)
  })
})

describe("title write and refresh", () => {
  test("refreshes the current session exactly once after a successful apply", async () => {
    const ui = fakeUi({ select: ["run", "apply"] })
    const { adapter, context, client } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(context.invalidations).toEqual(["ses_current"])
    expect(context.refreshes).toEqual(["ses_current"])
    expect(ui.toasts.some((toast) => toast.variant === "success" && toast.message === "New title: Generated title")).toBe(true)
  })

  test("uses the live update contract when the runtime exposes no rename", async () => {
    const ui = fakeUi({ select: ["run", "apply"] })
    const client = fakeClient({
      withoutRename: true,
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
    })
    const { adapter, context } = setup({ ui, client })

    await openRetitle(ui, adapter, "")

    expect(client.calls.updates).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(client.calls.renames).toEqual([])
    expect(context.invalidations).toEqual(["ses_current"])
    expect(context.refreshes).toEqual(["ses_current"])
    expect(ui.toasts.some((toast) => toast.message.startsWith("New title"))).toBe(true)
  })

  test("still reports success when the refresh fails, and logs it", async () => {
    const log = recordingLogger()
    const ui = fakeUi({ select: ["run", "apply"] })
    const { adapter, context, client } = setup({ ui, refresh: "reject", logger: log.logger })

    await openRetitle(ui, adapter, "")

    expect(client.calls.renames).toHaveLength(1)
    expect(context.invalidations).toEqual(["ses_current"])
    expect(context.refreshes).toEqual(["ses_current"])
    expect(ui.toasts.some((toast) => toast.variant === "success")).toBe(true)
    expect(ui.toasts.some((toast) => toast.variant === "error")).toBe(false)
    expect(log.events.some((event) => event.name === "session-refresh-error")).toBe(true)
  })

  test("logs progress and the write operation as metadata, never the title", async () => {
    const log = recordingLogger()
    const ui = fakeUi({ select: ["run", "apply"] })
    const { adapter } = setup({ ui, logger: log.logger })

    await openRetitle(ui, adapter, "")

    const progressEvents = log.events.filter((event) => event.name.startsWith("progress-"))
    expect(progressEvents).toEqual([
      { name: "progress-shown", fields: { stage: "generating" } },
      { name: "progress-cleared", fields: { stage: "generating" } },
      { name: "progress-shown", fields: { stage: "applying" } },
      { name: "progress-cleared", fields: { stage: "applying" } },
    ])
    expect(log.text()).not.toContain("Generated title")
  })
})
