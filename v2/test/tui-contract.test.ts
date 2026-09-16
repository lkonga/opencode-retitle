// Boundary guards for the V2 port.
//
// Everything asserted here is a fact about the *artifact* — which file the V2
// loader resolves, which modules exist in the V2 graph, which of them may touch
// the filesystem, and which files are frozen — rather than a runtime behaviour.
// The module-graph assertions are made against a real parse of every V2 source
// (`Bun.Transpiler.scan`), so they do not break on formatting, quoting or
// comment changes the way a source substring match would. The behavioural
// counterparts live in the other test files: settings use only the host's
// durable storage (`adapter.test.ts`), and the log path ignores the V1 config
// environment (`logger.test.ts`).

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const v2 = path.resolve(import.meta.dir, "..")
const root = path.resolve(v2, "..")

const read = (file: string) => fs.readFileSync(file, "utf8")
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
/** Strips `//` comments so structural scans describe code, not prose. */
const code = (source: string) =>
  source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")

/** Every TypeScript source of the V2 plugin (tests excluded). */
const V2_MODULES = fs
  .readdirSync(v2, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
  .map((entry) => entry.name)

/** Parsed import specifiers of one module — a parse, not a substring match. */
function importsOf(file: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" })
  return transpiler.scan(read(file)).imports.map((item) => item.path)
}

/** Resolves a relative specifier the way the loader would, if it exists. */
function resolvesTo(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return undefined
}

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
    // must exist with a resolvable extension — and a `tui.ts` sibling must not
    // exist, or the loader's extension order decides which one wins.
    expect(fs.existsSync(path.join(v2, "tui.tsx"))).toBe(true)
    expect(fs.existsSync(path.join(v2, "tui.ts"))).toBe(false)
  })

  test("imports only the runtime-mapped plugin specifier at the top level", () => {
    const tui = path.join(v2, "tui.tsx")
    const bare = importsOf(tui).filter((specifier) => !specifier.startsWith("."))
    expect(bare).toEqual(["@opencode/plugin/tui"])

    // Every internal import resolves inside the V2 directory.
    for (const specifier of importsOf(tui).filter((item) => item.startsWith("."))) {
      const target = resolvesTo(tui, specifier)
      expect(target, `${specifier} must resolve`).toBeDefined()
      expect(path.relative(v2, target as string).startsWith("..")).toBe(false)
    }
  })

  test("mounts one app slot and registers one keymap layer", () => {
    // The one guarantee a local test cannot observe behaviourally: the plugin
    // is activated by the runtime, and only the runtime can say how many times
    // `setup` ran. Counted on comment-stripped source; the runtime smoke on the
    // V2 binary (recorded on issue #239) covers the behavioural side.
    const source = code(read(path.join(v2, "tui.tsx")))
    expect(source.match(/ui\.slot\(/g)).toHaveLength(1)
    expect(source.match(/keymap\.layer\(/g)).toHaveLength(1)
    expect(source).toContain('append: "app"')
    expect(source).toContain("Plugin.define({")
  })
})

describe("V2 module graph", () => {
  test("no V2 module imports the V1 entrypoint", () => {
    const v1Entry = path.join(root, "tui.ts")
    const offenders = V2_MODULES.filter((file) =>
      importsOf(path.join(v2, file))
        .filter((specifier) => specifier.startsWith("."))
        .some((specifier) => resolvesTo(path.join(v2, file), specifier) === v1Entry),
    )
    expect(offenders).toEqual([])
  })

  test("the log file is the only file any V2 module can open", () => {
    // V1 resolved its settings from `$OPENCODE_CONFIG_DIR || ~/.config/opencode`
    // and wrote `retitle-config.json` there. V2 keeps its state in the host's
    // durable storage, so no V2 module needs a filesystem or OS import other
    // than the log append, and the log path is asserted behaviourally in
    // `logger.test.ts` to ignore the V1 config environment.
    const filesystemImporters = V2_MODULES.filter((file) =>
      importsOf(path.join(v2, file)).some((specifier) => /^(node:)?(fs|os|path)$/.test(specifier)),
    )
    expect(filesystemImporters).toEqual(["logger.ts"])
  })

  test("no V2 source names a V1 config location in executable code", () => {
    // Names, not formatting: these identifiers cannot appear in code that is
    // supposed to reach the V2 state root only. Comments may name them to
    // explain why they are never used, so comments are stripped first.
    const markers = ["OPENCODE_CONFIG_DIR", "retitle-config", "homedir"]
    const offenders = V2_MODULES.filter((file) => markers.some((marker) => code(read(path.join(v2, file))).includes(marker)))
    expect(offenders).toEqual([])
  })
})

describe("V1 isolation", () => {
  test("the V1 entrypoint and package manifest are byte-identical", () => {
    for (const [file, expected] of Object.entries(V1_HASHES)) {
      expect(sha256(path.join(root, file)), `${file} changed`).toBe(expected)
    }
    const rootPackage = JSON.parse(read(path.join(root, "package.json")))
    expect(rootPackage.exports["./tui"]).toBe("./tui.ts")
  })
})
