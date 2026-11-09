import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("auto footer binds the granted-run observer to reactive status and an 80ms spinner", () => {
  const source = readFileSync(new URL("../tui.tsx", import.meta.url), "utf8")
  expect(source).toContain('append: "prompt.footer.status"')
  expect(source).toContain("const [pendingAuto, setPendingAuto] = createSignal(0)")
  expect(source).toContain("const [pendingBatch, setPendingBatch] = createSignal(0)")
  expect(source).toContain("<Show when={pendingBatch() > 0 || pendingAuto() > 0 || pendingInteractive() > 0}>")
  expect(source).toContain('<spinner frames={SPINNER_FRAMES} interval={80} />')
  expect(source).toContain("pendingBatch() > 0")
  expect(source).toContain('batchText() ?? `/${RETITLE_AUTO_SESSIONS_SLASH_NAME}`')
  expect(source).toContain("pendingAuto() > 0")
  expect(source).toContain('`/${RETITLE_AUTO_SLASH_NAME}`')
  expect(source).toContain('"/retitle"')
  expect(source).toContain("openRetitleAuto(props.context, props.adapter, rawArgs, props.onAutoPendingChange)")
  expect(source).toContain("setPendingAuto((n) => Math.max(0, n + delta))")
})
