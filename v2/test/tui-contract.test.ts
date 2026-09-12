import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const source = fs.readFileSync(path.join(root, "tui.tsx"), "utf8")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))

describe("V2 TUI public contract", () => {
  test("registers a globally reachable slash command", () => {
    expect(source).toContain('mode: "global"')
    expect(source).toContain('slash: { name: "retitle", arguments: true }')
    expect(source).toContain('id: "retitle.session.retitle"')
  })

  test("uses only the public V2 TUI plugin boundary", () => {
    expect(source).toContain('from "@opencode/plugin/tui"')
    expect(source).toContain("Plugin.define({")
    expect(source).toContain('context.ui.slot({ append: "app"')
    expect(source).not.toContain("packages/tui/src/")
    expect(source).not.toContain("packages/core/src/")
  })

  test("keeps the V2 log source distinct from model selection", () => {
    expect(source).toContain('modelSource: settings.model ? "settings-override"')
    expect(source).not.toContain('source: settings.model ? "settings-override"')
  })

  test("exports the directory-resolved TUI entrypoint", () => {
    expect(pkg.exports["./tui"]).toBe("./tui.tsx")
  })
})
