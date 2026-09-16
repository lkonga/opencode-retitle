// Behavioural tests for the context -> ports adapter: durable settings without a
// config file, bounded history with a store fallback, model resolution and the
// debounce gates.

import { describe, expect, test } from "bun:test"
import { createRetitleAdapter, effectiveModelLabel } from "../adapter"
import { RetitleError } from "../errors"
import type { RetitleMessage } from "../retitle-core"
import { fakeCatalog, fakeClient, fakeContext, fakeStorage, userMessage } from "./fake"

function adapterFor(input: Parameters<typeof fakeContext>[0], options: Parameters<typeof createRetitleAdapter>[1] = {}) {
  const context = fakeContext(input)
  return { context, adapter: createRetitleAdapter(context, { logger: quietLogger(), ...options }) }
}

function quietLogger() {
  return { event: () => {} }
}

describe("settings", () => {
  test("persists the model override through durable host storage", async () => {
    const storage = fakeStorage()
    const { adapter } = adapterFor({ client: fakeClient().client, storage: storage.storage })

    expect(adapter.settings.read()).toEqual({ model: "" })

    await adapter.settings.setModel("openai/gpt-5")

    expect(adapter.settings.read()).toEqual({ model: "openai/gpt-5" })
    expect(storage.writes).toEqual([{ model: "openai/gpt-5" }])
  })

  test("reads a corrupted persisted value defensively", async () => {
    const storage = fakeStorage({ model: 42 })
    const { adapter } = adapterFor({ client: fakeClient().client, storage: storage.storage })
    expect(adapter.settings.read()).toEqual({ model: "" })
  })
})

describe("history", () => {
  test("prefers the bounded client page and does not touch the host store", async () => {
    const { client, calls } = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
    })
    const { context, adapter } = adapterFor({ client, messages: [{ type: "user", text: "store copy" }] })

    const messages = await adapter.ports.loadMessages("ses_1")

    expect(messages.map((message) => message.text)).toEqual(["hello"])
    expect(calls.lists).toHaveLength(1)
    expect(context.syncs).toEqual([])
  })

  test("falls back to the host store and stays bounded when the client page is empty", async () => {
    const store = Array.from({ length: 250 }, (_, index) => userMessage(`turn ${index}`))
    const { client } = fakeClient({ list: () => ({ data: [], cursor: {} }) })
    const { context, adapter } = adapterFor({ client, messages: store })

    const messages = await adapter.ports.loadMessages("ses_1")

    expect(context.syncs).toEqual(["ses_1"])
    expect(messages).toHaveLength(200)
    expect(messages[0].text).toBe("turn 50")
    expect(messages.at(-1)?.text).toBe("turn 249")
  })
})

describe("model resolution", () => {
  test("prefers the settings override, then the title agent, then the session model", async () => {
    const client = fakeClient().client

    const override = adapterFor({
      client,
      catalog: fakeCatalog({ models: [{ id: "gpt-5", providerID: "openai" }] }),
      sessionModel: { id: "session-model", providerID: "session" },
    }).adapter
    expect(await override.ports.resolveModel("ses_1", [], "openai/gpt-5")).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })

    const viaAgent = adapterFor({
      client,
      catalog: fakeCatalog({
        models: [{ id: "agent-model", providerID: "agent" }],
        agents: [{ id: "title", model: { id: "agent-model", providerID: "agent" } }],
      }),
      sessionModel: { id: "session-model", providerID: "session" },
    }).adapter
    expect(await viaAgent.ports.resolveModel("ses_1", [], "")).toEqual({ providerID: "agent", modelID: "agent-model" })

    const viaSession = adapterFor({
      client,
      catalog: fakeCatalog({ models: [{ id: "session-model", providerID: "session" }] }),
      sessionModel: { id: "session-model", providerID: "session" },
    }).adapter
    expect(await viaSession.ports.resolveModel("ses_1", [], "")).toEqual({
      providerID: "session",
      modelID: "session-model",
    })
  })

  test("falls back to the last assistant model, then the first catalogue model", async () => {
    const client = fakeClient().client

    const fromMessages = adapterFor({ client, catalog: fakeCatalog() }).adapter
    const messages: RetitleMessage[] = [
      { role: "user", text: "q" },
      { role: "assistant", text: "a", model: { providerID: "msg", modelID: "message-model" } },
    ]
    expect(await fromMessages.ports.resolveModel("ses_1", messages, "")).toEqual({
      providerID: "msg",
      modelID: "message-model",
    })

    const fromCatalog = adapterFor({ client, catalog: fakeCatalog({ models: [{ id: "first", providerID: "p" }] }) }).adapter
    expect(await fromCatalog.ports.resolveModel("ses_1", [], "")).toEqual({ providerID: "p", modelID: "first" })
  })

  test("rejects a configured model that the loaded catalogue does not have", async () => {
    const catalog = fakeCatalog({ models: [{ id: "real", providerID: "openai" }] })
    const { adapter } = adapterFor({ client: fakeClient().client, catalog })

    const failure = adapter.ports.resolveModel("ses_1", [], "openai/made-up").catch((error) => error)

    expect(await failure).toBeInstanceOf(RetitleError)
    expect((await failure) as RetitleError).toMatchObject({ code: "model" })
  })

  test("does not fail on an unloaded catalogue but rejects a malformed override", async () => {
    const empty = adapterFor({ client: fakeClient().client, catalog: fakeCatalog() }).adapter
    expect(await empty.ports.resolveModel("ses_1", [], "openai/made-up")).toEqual({
      providerID: "openai",
      modelID: "made-up",
    })

    const malformed = adapterFor({ client: fakeClient().client, catalog: fakeCatalog() }).adapter
    expect(await malformed.ports.resolveModel("ses_1", [], "no-slash").catch((e) => e)).toMatchObject({
      code: "model",
    })
  })

  test("syncs empty collections before resolving", async () => {
    const catalog = fakeCatalog()
    const { adapter } = adapterFor({ client: fakeClient().client, catalog })

    await adapter.ports.resolveModel("ses_1", [], "openai/gpt-5").catch(() => {})

    expect(catalog.synced).toEqual(["model", "provider", "agent"])
  })

  test("labels the effective model for the settings dialog", () => {
    expect(effectiveModelLabel(fakeCatalog(), "openai/gpt-5")).toBe("openai/gpt-5")
    expect(
      effectiveModelLabel(fakeCatalog({ agents: [{ id: "title", model: { id: "m", providerID: "p" } }] }), ""),
    ).toBe("p/m")
    expect(effectiveModelLabel(fakeCatalog(), "")).toBe("auto")
  })
})

describe("generation wiring", () => {
  test("pins the helper to the resolved location and model", async () => {
    const { client, calls } = fakeClient()
    const { adapter } = adapterFor({
      client,
      location: { directory: "/workspace/app" },
    })

    await adapter.ports.generateTitle({
      sessionID: "ses_1",
      prompt: "prompt",
      model: { providerID: "openai", modelID: "gpt-5" },
    })

    expect(calls.creates[0]).toMatchObject({
      agent: "title",
      model: { id: "gpt-5", providerID: "openai" },
      location: { directory: "/workspace/app" },
    })
  })

  test("uses the host default location when the plugin context has none", async () => {
    const { client, calls } = fakeClient()
    const { adapter } = adapterFor({ client })

    await adapter.ports.generateTitle({
      sessionID: "ses_1",
      prompt: "prompt",
      model: { providerID: "openai", modelID: "gpt-5" },
    })

    expect(calls.creates[0].location).toEqual({ directory: "/workspace/default" })
  })
})

describe("toast debounce", () => {
  test("suppresses the same failure inside the window and allows a different one", () => {
    let now = 1000
    const { adapter } = adapterFor({ client: fakeClient().client }, { now: () => now, toastWindowMs: 500 })

    expect(adapter.toastAllowed("error:generate")).toBe(true)
    expect(adapter.toastAllowed("error:generate")).toBe(false)
    expect(adapter.toastAllowed("error:deadline")).toBe(true)
    now += 600
    expect(adapter.toastAllowed("error:generate")).toBe(true)
  })
})

describe("runtime contract drift", () => {
  test("degrades instead of crashing when the host stops publishing the catalogue", async () => {
    const context = {
      client: fakeClient().client,
      data: {
        location: {},
        session: { get: () => undefined, message: { list: () => [], sync: async () => {} } },
      },
      storage: fakeStorage().storage,
    } as never
    const adapter = createRetitleAdapter(context, { logger: quietLogger() })

    expect(adapter.catalog().model.list()).toEqual([])
    expect(adapter.catalog().provider.list()).toEqual([])
    expect(adapter.catalog().agent.list()).toEqual([])
    await expect(adapter.ports.resolveModel("ses_1", [], "")).rejects.toMatchObject({ code: "model" })
  })

  test("keeps /retitle usable when durable settings cannot be opened", async () => {
    const storage = {
      store() {
        throw new Error("storage unavailable")
      },
    } as never
    const { adapter } = adapterFor({ client: fakeClient().client, storage })

    expect(adapter.settings.read()).toEqual({ model: "" })
    await adapter.settings.setModel("openai/gpt-5")
    expect(adapter.settings.read()).toEqual({ model: "openai/gpt-5" })
  })

  test("degrades to an empty history when the synced store is unavailable", async () => {
    const context = {
      client: fakeClient({ list: () => ({ data: [], cursor: {} }) }).client,
      location: undefined,
      data: { location: {}, session: { get: () => undefined, message: { list: () => [], sync: async () => {} } } },
      storage: fakeStorage().storage,
    } as never
    const adapter = createRetitleAdapter(context, { logger: quietLogger() })

    expect(await adapter.ports.loadMessages("ses_1")).toEqual([])
    expect(adapter.catalog().model.list()).toEqual([])
  })
})
