// Public-boundary and V1-preservation guards for the V2 port.
//
// These are negative/structural constraints that cannot be expressed as a
// runtime behaviour, so they are asserted directly:
//   * the directory entrypoint the V2 loader resolves (`<dir>/tui`);
//   * the runtime specifier the V2 binary maps for external TUI plugins;
//   * the absence of any V1 config-directory path in the V2 sources;
//   * byte-identical V1 files.

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const v2 = path.resolve(import.meta.dir, "..")
const root = path.resolve(v2, "..")

const read = (file: string) => fs.readFileSync(file, "utf8")
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
/** Strips `//` comments so structural counts describe code, not prose. */
const code = (source: string) =>
  source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")

/** V1 files are frozen: update these only as part of an explicit V1 change. */
const V1_HASHES = {
  "tui.ts": "3d7a9b62b472bdd66ec547730be9c7cee50119d149ab6eb0f59c13b4cb11873a",
  "package.json": "f4cab7e77eec7e476a27bb0e9590fa2a0734d679c7523de6aea9faee7fb2b0db",
} as const

const pkg = JSON.parse(read(path.join(v2, "package.json")))

describe("V2 entrypoint", () => {
  test("exposes the directory-resolved ./tui entrypoint the loader resolves", () => {
    expect(pkg.exports["./tui"]).toBe("./tui.tsx")
    // resolveLocal() joins `<dir>/tui` and resolves it as a path, so the file
    // must exist with a resolvable extension.
    expect(fs.existsSync(path.join(v2, "tui.tsx"))).toBe(true)
    expect(fs.existsSync(path.join(v2, "tui.ts"))).toBe(false)
  })

  test("imports only the runtime-mapped plugin specifier", () => {
    const source = read(path.join(v2, "tui.tsx"))
    expect(source).toContain('from "@opencode/plugin/tui"')
    expect(source).not.toContain("packages/tui/src/")
    expect(source).not.toContain("packages/core/src/")
    expect(source).not.toContain("@opencode-ai/plugin")
  })

  test("mounts one app slot and registers one keymap layer", () => {
    const source = code(read(path.join(v2, "tui.tsx")))
    expect(source.match(/ui\.slot\(/g)).toHaveLength(1)
    expect(source.match(/keymap\.layer\(/g)).toHaveLength(1)
    expect(source).toContain('append: "app"')
    expect(source).toContain("Plugin.define({")
  })
})

describe("V1 isolation", () => {
  test("no V2 source can reach the V1 config directory", () => {
    const offenders = fs
      .readdirSync(v2, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
      .filter((entry) => {
        // Executable patterns only: comments may name the V1 path to explain
        // why it is never used.
        const source = code(read(path.join(v2, entry.name)))
        return (
          source.includes("process.env.OPENCODE_CONFIG_DIR") ||
          source.includes("retitle-config") ||
          source.includes("homedir(")
        )
      })
      .map((entry) => entry.name)

    expect(offenders).toEqual([])
  })

  test("the V2 entrypoint never imports the V1 entrypoint", () => {
    const modules = fs
      .readdirSync(v2)
      .filter((name) => /\.(ts|tsx)$/.test(name))
      .map((name) => ({ name, source: read(path.join(v2, name)) }))

    const offenders = modules
      .filter(({ name }) => name !== "tui.tsx")
      .filter(({ source }) => source.includes('from "../tui"') || source.includes("from './../tui'"))
      .map(({ name }) => name)
    expect(offenders).toEqual([])
  })

  test("the V1 entrypoint and package manifest are byte-identical", () => {
    for (const [file, expected] of Object.entries(V1_HASHES)) {
      expect(sha256(path.join(root, file)), `${file} changed`).toBe(expected)
    }
    const rootPackage = JSON.parse(read(path.join(root, "package.json")))
    expect(rootPackage.exports["./tui"]).toBe("./tui.ts")
    expect(read(path.join(root, "tui.ts"))).toContain("keymap.registerLayer")
  })
})
