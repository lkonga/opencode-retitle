import { describe, expect, test } from "bun:test"
import { createRetitleAdapter } from "../adapter"
import { ContinuousRetitle } from "../continuous"
import { readContinuous } from "../continuous-settings"
import { createRunGate } from "../gate"
import { fakeClient, fakeContext, fakeCatalog, userMessage } from "./fake"

async function setup(shadowMode = true) {
  const client = fakeClient()
  const adapter = createRetitleAdapter(fakeContext({ client: client.client,
    catalog: fakeCatalog({ models: [{ id: "model", providerID: "provider" }] }),
    messages: [userMessage("docker container registry")] }), {
    logger: { event() {} }, gate: createRunGate({ debounceMs: 0 }),
  })
  await adapter.settings.setContinuous!({ ...readContinuous(), enabled: true, mode: "cadence", turnInterval: 2, shadowMode })
  let applies = 0
  const evaluator = new ContinuousRetitle(adapter, async () => { applies++; return "self title" })
  const turn = (turnIndex: number, title = "old") => evaluator.observe({ sessionID: "s", title, turnIndex, text: "docker container registry" })
  return { client, adapter, evaluator, turn, applies: () => applies }
}
describe("continuous evaluator", () => {
  test("stages shadow candidates without renaming or auto application", async () => {
    const s = await setup()
    await s.turn(10); await s.turn(11)
    expect(s.adapter.candidates!.pending()).toHaveLength(0)
    await s.turn(12)
    expect(s.adapter.candidates!.pending()).toHaveLength(1)
    expect(s.client.calls.renames).toHaveLength(0)
    expect(s.applies()).toBe(0)
  })
  test("auto mode dispatches unattended runner and recognizes its own title", async () => {
    const s = await setup(false)
    await s.turn(0); await s.turn(2); await s.turn(3, "self title"); await s.turn(4, "self title")
    expect(s.applies()).toBe(2)
  })
  test("foreign rename clears proposals and pauses future runs", async () => {
    const s = await setup()
    await s.turn(0); await s.turn(2)
    await s.turn(3, "manual rename"); await s.turn(20, "manual rename")
    expect(s.adapter.candidates!.pending()).toHaveLength(0)
    expect(s.adapter.candidates!.list()[0]!.state).toBe("superseded")
  })
  test("disabled is inert and restored history is not replayed", async () => {
    const s = await setup()
    await s.adapter.settings.setContinuous!(readContinuous())
    await s.turn(50); await s.turn(100)
    expect(s.client.calls.generates).toHaveLength(0)
  })
  test("semantic confirmation runs only on new turns", async () => {
    const s = await setup()
    await s.adapter.settings.setContinuous!({ ...readContinuous(), enabled: true })
    await s.turn(0); await s.turn(1); await s.turn(1)
    expect(s.adapter.candidates!.pending()).toHaveLength(0)
    await s.turn(2)
    expect(s.adapter.candidates!.pending()).toHaveLength(1)
  })
  test("own reactive rename during auto apply does not pause subsequent turns", async () => {
    const s = await setup(false)
    let count = 0
    let evaluator: ContinuousRetitle
    evaluator = new ContinuousRetitle(s.adapter, async (sessionID, guarded) => {
      await guarded.ports.applyTitle(sessionID, "self title")
      await evaluator.observe({ sessionID, title: "self title", turnIndex: 2, text: "docker container registry" })
      count++
      return "self title"
    })
    await evaluator.observe({ sessionID: "s", title: "old", turnIndex: 0, text: "" })
    await evaluator.observe({ sessionID: "s", title: "old", turnIndex: 2, text: "docker container registry" })
    await evaluator.observe({ sessionID: "s", title: "self title", turnIndex: 4, text: "docker container registry" })
    expect(count).toBe(2)
  })
})
