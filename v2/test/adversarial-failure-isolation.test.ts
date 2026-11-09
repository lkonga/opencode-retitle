import { describe, expect, test } from "bun:test"
import { createRetitleAdapter } from "../adapter"
import { openRetitleAuto } from "../dialogs"
import { fakeCatalog, fakeClient, fakeContext, fakeUi, recordingLogger, userMessage } from "./fake"

describe("adversarial failure isolation", () => {
  test("independent concurrent MAIN failures both notify through one adapter/UI", async () => {
    let rejectA!: (reason: Error) => void
    let rejectB!: (reason: Error) => void
    const a = new Promise((_, reject) => {
      rejectA = reject
    })
    const b = new Promise((_, reject) => {
      rejectB = reject
    })
    let id = 0
    const client = fakeClient({
      create: () => ({ id: `ses_helper_${++id}` }),
      list: (input) => ({ data: [userMessage(`hello in ${input.sessionID}`)], cursor: {} }),
      generate: (input) => (input.prompt.includes("ses_A") ? a : b),
    })
    const ui = fakeUi({ sessionID: "ses_A" })
    const log = recordingLogger()
    const context = fakeContext({
      client: client.client,
      catalog: fakeCatalog({ models: [{ id: "gpt-5", providerID: "openai" }] }),
      messages: [userMessage("hello")],
    })
    const adapter = createRetitleAdapter(context, { logger: log.logger, now: () => 10_000 })
    const wait = async (count: number) => {
      for (let i = 0; i < 100 && client.calls.generates.length < count; i++) await Promise.resolve()
      expect(client.calls.generates).toHaveLength(count)
    }

    const pA = openRetitleAuto(ui, adapter, "")
    await wait(1)
    ui.setRoute({ type: "session", sessionID: "ses_B" })
    const pB = openRetitleAuto(ui, adapter, "")
    await wait(2)

    expect(adapter.gate.running("ses_A")).toBe(true)
    expect(adapter.gate.running("ses_B")).toBe(true)

    rejectA(new Error("provider A failed"))
    await pA
    expect(ui.toasts.filter((t) => t.variant === "error")).toHaveLength(1)

    rejectB(new Error("provider B failed"))
    await pB

    expect(adapter.gate.running()).toBe(false)
    expect(new Set(client.calls.removes).size).toBe(2)
    expect(ui.toasts.filter((t) => t.variant === "error")).toHaveLength(2)
  })

  test("distinct sessions with same failure both notify, but same-session repeated failure is debounced", async () => {
    let now = 10_000
    const client = fakeClient({
      list: (input) => ({ data: [userMessage(`msg in ${input.sessionID}`)], cursor: {} }),
      generate: () => {
        throw new Error("provider exploded")
      },
    })
    const uiA = fakeUi({ sessionID: "ses_A" })
    const uiB = fakeUi({ sessionID: "ses_B" })
    const context = fakeContext({
      client: client.client,
      catalog: fakeCatalog({ models: [{ id: "gpt-5", providerID: "openai" }] }),
    })
    const adapter = createRetitleAdapter(context, { now: () => now })

    // Session A fails -> gets toast
    await openRetitleAuto(uiA, adapter, "")
    expect(uiA.toasts.filter((t) => t.variant === "error")).toHaveLength(1)

    // Immediate same Session A retry is debounced
    now += 1_000
    await openRetitleAuto(uiA, adapter, "")
    expect(uiA.toasts.filter((t) => t.variant === "error")).toHaveLength(1)

    // Distinct Session B fails with identical error -> MUST get toast through same shared adapter
    await openRetitleAuto(uiB, adapter, "")
    expect(uiB.toasts.filter((t) => t.variant === "error")).toHaveLength(1)

    // Immediate same Session B retry is also debounced
    now += 1_000
    await openRetitleAuto(uiB, adapter, "")
    expect(uiB.toasts.filter((t) => t.variant === "error")).toHaveLength(1)
  })

  test("distinct sessions both empty both notify, but same-session repeated empty is debounced", async () => {
    let now = 10_000
    const client = fakeClient({
      list: () => ({ data: [], cursor: {} }), // empty sessions
    })
    const uiA = fakeUi({ sessionID: "ses_A" })
    const uiB = fakeUi({ sessionID: "ses_B" })
    const context = fakeContext({
      client: client.client,
      catalog: fakeCatalog({ models: [{ id: "gpt-5", providerID: "openai" }] }),
    })
    const adapter = createRetitleAdapter(context, { now: () => now })

    // Session A is empty -> gets warning toast
    await openRetitleAuto(uiA, adapter, "")
    expect(
      uiA.toasts.filter((t) => t.variant === "warning" && t.message.includes("Nothing to retitle yet")),
    ).toHaveLength(1)

    // Immediate same Session A retry is debounced
    now += 1_000
    await openRetitleAuto(uiA, adapter, "")
    expect(
      uiA.toasts.filter((t) => t.variant === "warning" && t.message.includes("Nothing to retitle yet")),
    ).toHaveLength(1)

    // Distinct Session B is also empty -> MUST get warning toast
    await openRetitleAuto(uiB, adapter, "")
    expect(
      uiB.toasts.filter((t) => t.variant === "warning" && t.message.includes("Nothing to retitle yet")),
    ).toHaveLength(1)

    // Immediate same Session B retry is debounced
    now += 1_000
    await openRetitleAuto(uiB, adapter, "")
    expect(
      uiB.toasts.filter((t) => t.variant === "warning" && t.message.includes("Nothing to retitle yet")),
    ).toHaveLength(1)
  })

  test("distinct sessions with same no-title both notify, but same-session repeated no-title is debounced", async () => {
    let now = 10_000
    const client = fakeClient({
      list: () => ({ data: [userMessage("hello")], cursor: {} }),
      generate: () => ({ text: "" }), // returns empty string -> no-title outcome
    })
    const uiA = fakeUi({ sessionID: "ses_A" })
    const uiB = fakeUi({ sessionID: "ses_B" })
    const context = fakeContext({
      client: client.client,
      catalog: fakeCatalog({ models: [{ id: "gpt-5", providerID: "openai" }] }),
    })
    const adapter = createRetitleAdapter(context, { now: () => now })

    // Session A returns no title -> gets warning toast
    await openRetitleAuto(uiA, adapter, "")
    expect(uiA.toasts.filter((t) => t.variant === "warning" && t.message.includes("No title came back"))).toHaveLength(
      1,
    )

    // Immediate same Session A retry is debounced
    now += 1_000
    await openRetitleAuto(uiA, adapter, "")
    expect(uiA.toasts.filter((t) => t.variant === "warning" && t.message.includes("No title came back"))).toHaveLength(
      1,
    )

    // Distinct Session B also returns no title -> MUST get warning toast
    await openRetitleAuto(uiB, adapter, "")
    expect(uiB.toasts.filter((t) => t.variant === "warning" && t.message.includes("No title came back"))).toHaveLength(
      1,
    )

    // Immediate same Session B retry is debounced
    now += 1_000
    await openRetitleAuto(uiB, adapter, "")
    expect(uiB.toasts.filter((t) => t.variant === "warning" && t.message.includes("No title came back"))).toHaveLength(
      1,
    )
  })
})
