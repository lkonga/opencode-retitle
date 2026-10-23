// End-to-end command tests: single registration, no duplicate runs, and the
// full lifecycle from slash/palette invocation to the title write.

import { describe, expect, test } from "bun:test"
import { createRetitleAdapter, type RetitleAdapter } from "../adapter"
import {
  RETITLE_AUTO_COMMAND_ID,
  RETITLE_AUTO_SLASH_NAME,
  RETITLE_BIND,
  RETITLE_COMMAND_ID,
  RETITLE_SLASH_NAME,
  createRetitleAutoCommand,
  createRetitleCommand,
  retitleKeymapLayer,
} from "../command"
import { RetitleTimeoutError } from "../deadline"
import { openRetitle, openRetitleAuto } from "../dialogs"
import { PROGRESS_APPLYING, PROGRESS_GENERATING } from "../progress"
import type { RetitleLogger } from "../logger"
import { assistantMessage, fakeCatalog, fakeClient, fakeContext, fakeProgress, fakeUi, fakeUiAtHome, recordingLogger, userMessage } from "./fake"
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
  readonly now?: () => number
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
    ...(options.now ? { now: options.now } : {}),
  })
  return { client, context, adapter, ui: options.ui, progress }
}

describe("command registration", () => {
  test("registers the interactive and the auto command, each as a slash and palette command", () => {
    const layer = retitleKeymapLayer(
      () => {},
      () => {},
    )
    expect(layer.mode).toBe("global")
    expect(layer.commands).toHaveLength(2)

    const [command, auto] = layer.commands
    expect(command.id).toBe(RETITLE_COMMAND_ID)
    expect(command.palette).toBe(true)
    expect(command.slash).toEqual({ name: RETITLE_SLASH_NAME, arguments: true })

    expect(auto.id).toBe(RETITLE_AUTO_COMMAND_ID)
    expect(auto.palette).toBe(true)
    expect(auto.slash).toEqual({ name: RETITLE_AUTO_SLASH_NAME, arguments: true })
    expect(RETITLE_AUTO_COMMAND_ID).toBe("retitle.session.retitle_auto")
    expect(RETITLE_AUTO_SLASH_NAME).toBe("retitle-auto")
    expect(new Set(layer.commands.map((entry) => entry.id)).size).toBe(2)
    expect(new Set(layer.commands.map((entry) => entry.slash?.name)).size).toBe(2)
  })

  test("binds exactly one fixed stroke, owned by the interactive command alone", () => {
    const layer = retitleKeymapLayer(
      () => {},
      () => {},
    )

    // The runtime's layer builder validates the entry shape: an entry with an
    // `id`, `palette` and `slash` is a *named* command, while an entry without
    // an `id` may only carry `bind` ("Inline keymap commands require bind",
    // "Palette commands require an ID"). Both together are what makes this one
    // reachable command that also owns a key stroke, not an inline shortcut.
    const [command, auto] = layer.commands
    expect(typeof command.id).toBe("string")
    expect(command.palette).toBe(true)
    expect(command.slash).toBeDefined()
    expect(typeof command.bind).toBe("string")
    expect(command.bind).toBe(RETITLE_BIND)

    // The auto command is deliberately stroke-less: an unattended title write
    // must never be one stray keypress away from the interactive one.
    expect("bind" in auto).toBe(false)

    const strokes = layer.commands.flatMap((entry) =>
      typeof entry.bind === "string" ? entry.bind.split(",").map((stroke) => stroke.trim()) : [],
    )

    // A single stroke: the command fires on its own key, not on a sequence it
    // shares with another command.
    expect(RETITLE_BIND).toBe("ctrl+shift+r")
    expect(RETITLE_BIND.includes(",")).toBe(false)
    expect(strokes).toEqual([RETITLE_BIND])
    expect(new Set(strokes).size).toBe(strokes.length)
  })

  test("delivers the raw argument string to each handler exactly once per invocation", async () => {
    const seen: string[] = []
    const autoSeen: string[] = []
    const command = createRetitleCommand((rawArgs) => {
      seen.push(rawArgs)
    })
    const auto = createRetitleAutoCommand((rawArgs) => {
      autoSeen.push(rawArgs)
    })

    command.run("--samples 20 docker setup")
    command.run()
    auto.run("--samples 5")
    auto.run()

    await Promise.resolve()
    expect(seen).toEqual(["--samples 20 docker setup", ""])
    expect(autoSeen).toEqual(["--samples 5", ""])
  })

  test("contains a handler failure instead of rejecting into the keymap", async () => {
    const errors: unknown[] = []
    const autoErrors: unknown[] = []
    const command = createRetitleCommand(
      () => {
        throw new Error("boom")
      },
      (error) => errors.push(error),
    )
    const auto = createRetitleAutoCommand(
      async () => {
        throw new Error("auto boom")
      },
      (error) => autoErrors.push(error),
    )

    expect(() => command.run()).not.toThrow()
    expect(() => auto.run()).not.toThrow()
    // An async handler's rejection is adopted a tick later than a sync throw,
    // and the two commands are independent promises: drain deterministically
    // instead of guessing a fixed number of microtasks.
    await drainUntil(() => errors.length === 1 && autoErrors.length === 1)
    expect(errors).toHaveLength(1)
    expect(autoErrors).toHaveLength(1)
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
    const ui = fakeUi({ select: ["run", "apply", true] })
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
    const ui = fakeUi({ select: ["run", "apply", true] })
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
    const ui = fakeUi({ select: ["run", "edit", true], prompt: ["  My edited title  "] })
    const { adapter, client } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "My edited title" }])
  })

  test("apply requires confirmation (Y/n); declining returns to menu, confirming applies", async () => {
    // 1. run -> 2. apply -> 3. false (n, decline apply) -> 4. apply -> 5. true (Y, confirm apply)
    const ui = fakeUi({ select: ["run", "apply", false, "apply", true] })
    const { adapter, client } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(ui.selects).toHaveLength(5)
    expect(ui.selects[2].title).toContain('Apply title "Generated title"?')
    expect(ui.selects[4].title).toContain('Apply title "Generated title"?')
  })

  test("closing via escape/cancel requires confirmation (y/N); default N keeps menu open", async () => {
    // 1. run -> 2. cancel -> 3. false (N, keep menu open) -> 4. apply -> 5. true (Y, apply)
    const ui = fakeUi({ select: ["run", "cancel", false, "apply", true] })
    const { adapter, client } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(ui.selects[2].title).toBe("Discard generated title?")
  })

  test("explicit confirmation (y) on discard confirmation closes without applying", async () => {
    // 1. run -> 2. cancel -> 3. true (y, confirm discard)
    const ui = fakeUi({ select: ["run", "cancel", true] })
    const { adapter, client } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(client.calls.renames).toEqual([])
    expect(adapter.gate.running()).toBe(false)
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
    const ui = fakeUi({ select: ["run", "regenerate", "run", "apply", true] })
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
    const ui = fakeUi({ select: ["run", "apply", true] })
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

    // Only the first run reached the settings dialog, confirm menu, and confirm apply.
    expect(ui.selects).toHaveLength(3)
    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.generates).toHaveLength(1)
  })

  test("a later invocation is accepted once the window has passed", async () => {
    let now = 0
    const ui = fakeUi({ select: ["run", "cancel", true, "run", "cancel", true] })
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

    expect(ui.selects).toHaveLength(6)
    expect(client.calls.creates).toHaveLength(2)
  })
})

describe("progress feedback", () => {
  test("shows generation then apply progress, clearing each in turn", async () => {
    const ui = fakeUi({ select: ["run", "apply", true] })
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
    const ui = fakeUi({ select: ["run", "apply", true] })
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
    const ui = fakeUi({ select: ["run", "apply", true] })
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
    const ui = fakeUi({ select: ["run", "apply", true] })
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
    const ui = fakeUi({ select: ["run", "apply", true] })
    const { adapter, context, client } = setup({ ui })

    await openRetitle(ui, adapter, "")

    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(context.invalidations).toEqual(["ses_current"])
    expect(context.refreshes).toEqual(["ses_current"])
    expect(ui.toasts.some((toast) => toast.variant === "success" && toast.message === "New title: Generated title")).toBe(true)
  })

  test("uses the live update contract when the runtime exposes no rename", async () => {
    const ui = fakeUi({ select: ["run", "apply", true] })
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
    const ui = fakeUi({ select: ["run", "apply", true] })
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
    const ui = fakeUi({ select: ["run", "apply", true] })
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

describe("auto lifecycle (/retitle-auto)", () => {
  test("applies the first candidate with default settings and never opens a dialog", async () => {
    const ui = fakeUi({})
    const { adapter, client, progress, context } = setup({ ui })

    await openRetitleAuto(ui, adapter, "")

    // No settings dialog, no confirm menu, no prompt — and no progress surface,
    // because the auto run's lane is silent (in production it is `dialog.show`).
    expect(ui.selects).toEqual([])
    expect(ui.prompts).toEqual([])
    expect(progress.events).toEqual([])
    expect(progress.active()).toBeUndefined()

    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.generates).toHaveLength(1)
    expect(client.calls.removes).toEqual(["ses_helper"])
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(context.refreshes).toEqual(["ses_current"])
    expect(ui.toasts).toEqual([{ variant: "success", message: "New title: Generated title" }])
    expect(adapter.gate.running()).toBe(false)
  })

  test("seeds sampling and the steering hint from the raw argument string", async () => {
    const oldestFirst = [
      userMessage("turn 0 oldest user turn"),
      assistantMessage("turn 0 reply"),
      userMessage("turn 1 middle user turn"),
      assistantMessage("turn 1 reply"),
      userMessage("turn 2 recent user turn"),
      assistantMessage("turn 2 reply"),
      userMessage("turn 3 newest user turn"),
      assistantMessage("turn 3 reply"),
    ]
    const client = fakeClient({ list: () => ({ data: [...oldestFirst].reverse(), cursor: {} }) })
    const ui = fakeUi({})
    const { adapter } = setup({ ui, client, messages: oldestFirst })

    // --offset 4 limits history to the last 4 messages (turns 2 and 3).
    // --samples 2 selects both turns; "deploy notes" becomes the steering hint.
    await openRetitleAuto(ui, adapter, "--samples 2 --offset 4 deploy notes")

    const [generation] = client.calls.generates
    expect(generation.prompt).toContain("deploy notes")
    expect(generation.prompt).toContain("turn 3 newest user turn")
    expect(generation.prompt).toContain("turn 2 recent user turn")
    expect(generation.prompt).not.toContain("turn 0 oldest user turn")
    expect(generation.prompt).not.toContain("turn 1 middle user turn")
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(ui.selects).toEqual([])
  })

  test("respects saved model settings and resolves it through the catalog for generation", async () => {
    const log = recordingLogger()
    const ui = fakeUi({})
    const catalog = fakeCatalog({
      models: [
        { id: "gpt-5", providerID: "openai" },
        { id: "claude-3-haiku", providerID: "anthropic" },
      ],
    })
    const { adapter, client } = setup({ ui, catalog, logger: log.logger })

    await adapter.settings.setModel("anthropic/claude-3-haiku")
    await openRetitleAuto(ui, adapter, "")

    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.creates[0].model).toEqual({ id: "claude-3-haiku", providerID: "anthropic" })
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(ui.selects).toEqual([])
    expect(ui.prompts).toEqual([])
    expect(log.events.find((event) => event.name === "model-selected")?.fields).toMatchObject({
      providerID: "anthropic",
      modelID: "claude-3-haiku",
      modelSource: "settings-override",
      hasOverride: true,
    })
    expect(adapter.gate.running()).toBe(false)
  })

  test("refuses to run without a session, names /retitle-auto, and never claims the gate", async () => {
    const ui = fakeUiAtHome()
    const { adapter, progress } = setup({ ui })

    const deltas: Array<1 | -1> = []
    await openRetitleAuto(ui, adapter, "", (delta) => deltas.push(delta))

    expect(deltas).toEqual([])
    expect(adapter.gate.running()).toBe(false)
    expect(progress.events).toEqual([])
    expect(ui.selects).toEqual([])
    expect(ui.toasts).toEqual([{ variant: "warning", message: "Open a session before using /retitle-auto" }])
  })

  test("reports an empty session without opening anything and releases the gate", async () => {
    const ui = fakeUi({})
    const client = fakeClient({ list: () => ({ data: [], cursor: {} }) })
    const { adapter, progress } = setup({ ui, client, messages: [] })

    await openRetitleAuto(ui, adapter, "")

    expect(ui.selects).toEqual([])
    expect(progress.events).toEqual([])
    expect(ui.toasts.some((toast) => toast.variant === "warning" && toast.message.startsWith("Nothing to retitle yet"))).toBe(true)
    expect(client.calls.renames).toEqual([])
    expect(client.calls.generates).toEqual([])
    expect(adapter.gate.running()).toBe(false)
  })

  test("reports a model that returned no title without reopening settings", async () => {
    const ui = fakeUi({})
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => ({ text: "   " }),
    })
    const { adapter } = setup({ ui, client })

    await openRetitleAuto(ui, adapter, "")

    expect(ui.selects).toEqual([])
    expect(ui.prompts).toEqual([])
    expect(ui.toasts).toEqual([
      { variant: "warning", message: "No title came back from openai/gpt-5. Pick another model in settings." },
    ])
    expect(client.calls.renames).toEqual([])
    expect(adapter.gate.running()).toBe(false)
  })

  test("surfaces a generation failure as a toast only, with no dialog and no write", async () => {
    const ui = fakeUi({})
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => {
        throw new Error("provider 502")
      },
    })
    const { adapter, progress, context } = setup({ ui, client })

    await openRetitleAuto(ui, adapter, "")

    expect(ui.selects).toEqual([])
    expect(progress.events).toEqual([])
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0].variant).toBe("error")
    expect(ui.toasts[0].message).not.toContain("502")
    expect(client.calls.renames).toEqual([])
    expect(client.calls.removes).toEqual(["ses_helper"])
    expect(context.refreshes).toEqual([])
    expect(adapter.gate.running()).toBe(false)
  })

  test("reports an apply failure without a success toast, and releases the gate", async () => {
    const ui = fakeUi({})
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      rename: () => {
        throw new Error("write refused")
      },
    })
    const { adapter, progress, context } = setup({ ui, client })

    await openRetitleAuto(ui, adapter, "")

    expect(ui.selects).toEqual([])
    expect(progress.events).toEqual([])
    expect(ui.toasts.some((toast) => toast.message === "Failed to update session title")).toBe(true)
    expect(ui.toasts.some((toast) => toast.message.startsWith("New title"))).toBe(false)
    expect(context.refreshes).toEqual([])
    expect(adapter.gate.running()).toBe(false)
  })

  test("rejects an auto run while an interactive run is in flight, exactly as the interactive path does", async () => {
    const generation = deferred<{ text: string }>()
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => generation.promise,
    })
    const ui = fakeUi({ select: ["run", "apply", true] })
    const { adapter } = setup({ ui, client })

    const first = openRetitle(ui, adapter, "")
    await drainUntil(() => adapter.gate.running())

    await openRetitleAuto(ui, adapter, "")

    // Rejected before any work: the auto run neither creates a helper nor opens
    // a progress lane, and the toast matches the interactive wording.
    expect(ui.toasts.some((toast) => toast.message === "Retitle already running")).toBe(true)
    expect(adapter.gate.running()).toBe(true)
    expect(client.calls.creates).toHaveLength(0)

    generation.resolve({ text: "Generated title" })
    await first

    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(adapter.gate.running()).toBe(false)
  })

  test("rejects an interactive run while an auto run is in flight, and leaves its silent lane intact", async () => {
    const generation = deferred<{ text: string }>()
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => generation.promise,
    })
    const ui = fakeUi({ select: ["run", "apply", true] })
    const { adapter, progress } = setup({ ui, client })

    const first = openRetitleAuto(ui, adapter, "")
    await drainUntil(() => client.calls.generates.length === 1)

    await openRetitle(ui, adapter, "")

    // The shared gate rejects the interactive run: no dialog is opened, so the
    // queued answers stay unused, and the auto run's surface stays untouched.
    expect(ui.selects).toEqual([])
    expect(ui.toasts.some((toast) => toast.message === "Retitle already running")).toBe(true)
    expect(adapter.gate.running()).toBe(true)

    generation.resolve({ text: "Generated title" })
    await first

    expect(progress.events).toEqual([])
    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(adapter.gate.running()).toBe(false)
  })

  test("rejects an auto run while another auto run is in flight, ensuring exactly one apply and no UI", async () => {
    const generation = deferred<{ text: string }>()
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => generation.promise,
    })
    const ui = fakeUi({})
    const { adapter, progress } = setup({ ui, client })

    let pending = 0
    const deltas: Array<1 | -1> = []
    const trackPending = (delta: 1 | -1) => {
      deltas.push(delta)
      pending += delta
    }
    const first = openRetitleAuto(ui, adapter, "", trackPending)
    await drainUntil(() => client.calls.generates.length === 1)

    const second = openRetitleAuto(ui, adapter, "", trackPending)
    await second
    expect(pending).toBe(1)
    expect(deltas).toEqual([1])

    // The second auto run is rejected: toast matches, no additional helper or generation
    expect(ui.toasts.some((toast) => toast.message === "Retitle already running")).toBe(true)
    expect(adapter.gate.running()).toBe(true)
    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.generates).toHaveLength(1)

    generation.resolve({ text: "Generated title" })
    await first

    expect(pending).toBe(0)
    expect(deltas).toEqual([1, -1])
    expect(client.calls.creates).toHaveLength(1)
    expect(client.calls.generates).toHaveLength(1)
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(ui.selects).toEqual([])
    expect(ui.prompts).toEqual([])
    expect(progress.events).toEqual([])
    expect(progress.active()).toBeUndefined()
    expect(adapter.gate.running()).toBe(false)
  })

  test("catches unexpected settings.read failure, emits log and toast, and cleans up gate", async () => {
    const log = recordingLogger()
    const ui = fakeUi({})
    const { adapter, progress } = setup({ ui, logger: log.logger })

    const brokenAdapter: RetitleAdapter = {
      ...adapter,
      settings: {
        ...adapter.settings,
        read: () => {
          throw new Error("corrupted settings storage")
        },
      },
    }

    await openRetitleAuto(ui, brokenAdapter, "")

    expect(adapter.gate.running()).toBe(false)
    expect(ui.selects).toEqual([])
    expect(ui.prompts).toEqual([])
    expect(progress.events).toEqual([])
    expect(ui.toasts).toEqual([
      { variant: "error", message: "Retitle (auto) failed unexpectedly" },
    ])
    expect(log.events.some((event) => event.name === "auto-error")).toBe(true)
  })

  test("a failed auto run cleans up so the next invocation can run", async () => {
    let now = 0
    let call = 0
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => {
        call += 1
        if (call === 1) throw new Error("provider 502")
        return { text: "Second title" }
      },
    })
    const ui = fakeUi({})
    const { adapter } = setup({ ui, client, now: () => now })

    await openRetitleAuto(ui, adapter, "")
    expect(client.calls.renames).toEqual([])
    expect(adapter.gate.running()).toBe(false)

    now += 5_000
    await openRetitleAuto(ui, adapter, "")

    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Second title" }])
    expect(ui.selects).toEqual([])
    expect(adapter.gate.running()).toBe(false)
  })

  test("tracks in-flight auto status count during execution and cleans up on settle", async () => {
    const generation = deferred<{ text: string }>()
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => generation.promise,
    })
    const ui = fakeUi({})
    const { adapter } = setup({ ui, client })

    let pending = 0
    const deltas: Array<1 | -1> = []
    const promise = openRetitleAuto(ui, adapter, "", (delta) => {
      deltas.push(delta)
      pending += delta
    })
    expect(pending).toBe(1)

    await drainUntil(() => client.calls.generates.length === 1)
    expect(pending).toBe(1)

    generation.resolve({ text: "Async title" })
    await promise

    expect(pending).toBe(0)
    expect(deltas).toEqual([1, -1])
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Async title" }])
  })

  for (const [label, error] of [
    ["failure", new Error("generation error")],
    ["timeout", new RetitleTimeoutError(45_000, "generate")],
    ["cancellation", new DOMException("Generation cancelled", "AbortError")],
  ] as const) {
    test(`tracks in-flight auto status count drops back to 0 on ${label}`, async () => {
      const generation = deferred<{ text: string }>()
      const client = fakeClient({
        list: () => ({ data: [userMessage("hello")], cursor: {} }),
        generate: () => generation.promise,
      })
      const ui = fakeUi({})
      const { adapter } = setup({ ui, client })

      let pending = 0
      const deltas: Array<1 | -1> = []
      const promise = openRetitleAuto(ui, adapter, "", (delta) => {
        deltas.push(delta)
        pending += delta
      })
      await drainUntil(() => client.calls.generates.length === 1)
      expect(client.calls.generates).toHaveLength(1)
      expect(pending).toBe(1)

      generation.reject(error)
      await promise
      expect(pending).toBe(0)
      expect(deltas).toEqual([1, -1])
      expect(adapter.gate.running()).toBe(false)
      expect(client.calls.removes).toEqual(["ses_helper"])
      expect(client.calls.renames).toEqual([])
      expect(ui.toasts.some((toast) => toast.variant === "error")).toBe(true)
    })
  }

  test("a throwing pending observer cannot interrupt auto work or cleanup", async () => {
    const ui = fakeUi({})
    const { adapter, client, progress } = setup({ ui })
    const deltas: Array<1 | -1> = []

    await openRetitleAuto(ui, adapter, "", (delta) => {
      deltas.push(delta)
      throw new Error("status observer failed")
    })

    expect(deltas).toEqual([1, -1])
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Generated title" }])
    expect(adapter.gate.running()).toBe(false)
    expect(progress.active()).toBeUndefined()
  })

  test("tracks in-flight status label for interactive /retitle and cleans up", async () => {
    const generation = deferred<{ text: string }>()
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => generation.promise,
    })
    const ui = fakeUi({ select: ["run", "apply", true] })
    const { adapter } = setup({ ui, client })

    let activeLabel: string | null = null
    const runInteractive = async () => {
      activeLabel = "/retitle"
      try {
        await openRetitle(ui, adapter, "")
      } finally {
        activeLabel = null
      }
    }

    const promise = runInteractive()
    expect(activeLabel).toBe("/retitle")

    await drainUntil(() => client.calls.generates.length === 1)
    expect(activeLabel).toBe("/retitle")

    generation.resolve({ text: "Interactive title" })
    await promise

    expect(activeLabel).toBeNull()
    expect(client.calls.renames).toEqual([{ sessionID: "ses_current", title: "Interactive title" }])
  })
})
