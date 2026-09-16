// End-to-end command tests: single registration, no duplicate runs, and the
// full lifecycle from slash/palette invocation to the title write.

import { describe, expect, test } from "bun:test"
import { createRetitleAdapter } from "../adapter"
import { RETITLE_COMMAND_ID, RETITLE_SLASH_NAME, createRetitleCommand, retitleKeymapLayer } from "../command"
import { openRetitle } from "../dialogs"
import { fakeCatalog, fakeClient, fakeContext, fakeUi, fakeUiAtHome, userMessage } from "./fake"
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

function setup(options: {
  readonly ui: ReturnType<typeof fakeUi>
  readonly client?: ReturnType<typeof fakeClient>
  readonly messages?: Array<unknown>
  readonly catalog?: ReturnType<typeof fakeCatalog>
}) {
  const client = options.client ?? fakeClient({ list: () => ({ data: options.messages ?? [userMessage("hello")], cursor: {} }) })
  const context = fakeContext({
    client: client.client,
    catalog: options.catalog ?? fakeCatalog({ models: [{ id: "gpt-5", providerID: "openai" }] }),
    messages: options.messages ?? [userMessage("hello")],
  })
  const adapter = createRetitleAdapter(context, { logger: { event: () => {} } })
  return { client, adapter, ui: options.ui }
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
