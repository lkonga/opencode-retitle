import { describe, expect, test } from "bun:test"
import { createRetitleAdapter } from "../adapter"
import { readContinuous } from "../continuous-settings"
import { continuousMenuOptions, handleContinuousAction } from "../continuous-dialog"
import { createSettingsStore } from "../settings"
import { fakeClient, fakeContext, fakeStorage, fakeUi } from "./fake"

function setup() {
  const client = fakeClient()
  const adapter = createRetitleAdapter(fakeContext({ client: client.client }), { logger: { event() {} } })
  return { adapter, client }
}
describe("continuous settings and review", () => {
  test("defaults opt out, preserve shadow and manual protection", () => {
    expect(readContinuous()).toEqual({ enabled: false, mode: "semantic", turnInterval: 10, shadowMode: true, respectManualRename: true })
    expect(readContinuous({ mode: "bad", turnInterval: NaN }).turnInterval).toBe(10)
    expect(readContinuous({ turnInterval: 0 }).turnInterval).toBe(10)
  })
  test("persists continuous settings without losing model", async () => {
    const storage = fakeStorage()
    const settings = createSettingsStore(storage.storage)
    await settings.setModel("provider/model")
    await settings.setContinuous!({ ...readContinuous(), enabled: true })
    expect(settings.read().model).toBe("provider/model")
    expect(settings.read().continuous?.enabled).toBe(true)
  })
  test("menu toggles persist and queue count appears only when pending", async () => {
    const { adapter } = setup()
    const ui = fakeUi({})
    await handleContinuousAction(ui, adapter, "s", "continuous")
    await handleContinuousAction(ui, adapter, "s", "continuous-mode")
    await handleContinuousAction(ui, adapter, "s", "continuous-shadow")
    expect(adapter.settings.read().continuous).toMatchObject({ enabled: true, mode: "cadence", shadowMode: false })
    expect(continuousMenuOptions(adapter, "s")).toHaveLength(3)
    await adapter.candidates!.propose({ sessionID: "s", previousTitle: "old", proposedTitle: "new", reason: "cadence", evidence: { turnIndex: 10, keywords: [] } })
    expect(continuousMenuOptions(adapter, "s")[3]!.title).toContain("1 pending")
  })
  for (const action of ["apply", "edit", "reject"] as const) {
    test(`review ${action}`, async () => {
      const { adapter, client } = setup()
      await adapter.candidates!.propose({ sessionID: "s", previousTitle: "old", proposedTitle: "new", reason: "cadence", evidence: { turnIndex: 10, keywords: [] } })
      const ui = fakeUi({ select: ["1", action], prompt: ["edited"] })
      // The production selector returns numeric candidate IDs.
      const select = ui.ui.dialog.select.bind(ui.ui.dialog)
      ui.ui.dialog.select = async <T>(options: Parameters<typeof select<T>>[0]) => {
        const value = await select<T>(options)
        return (value === "1" ? 1 : value) as T | undefined
      }
      await handleContinuousAction(ui, adapter, "s", "continuous-review")
      expect(adapter.candidates!.list()[0]!.state).toBe(action === "reject" ? "rejected" : "accepted")
      expect(client.calls.renames.length).toBe(action === "reject" ? 0 : 1)
    })
  }
})
