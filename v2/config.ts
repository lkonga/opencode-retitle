// Persisted retitle settings, mirroring the V1 plugin's `retitle-config.json`
// semantics (`../tui.ts`) but written atomically and 0600. In V2 the plugin
// knows the config directory through `OPENCODE_CONFIG_DIR` (set by the `oc2`
// launcher to ~/.config/opencode-v2), so this never targets the V1 config.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type RetitlePersisted = {
  model?: string
}

export function configDirectory(): string {
  return process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode")
}

export function configPath(): string {
  return path.join(configDirectory(), "retitle-config.json")
}

export function readRetitleConfig(): RetitlePersisted {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as RetitlePersisted
  } catch {
    return {}
  }
}

export function writeRetitleConfigVal(key: keyof RetitlePersisted, value: string): void {
  const file = configPath()
  const next = { ...readRetitleConfig(), [key]: value }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  fs.renameSync(temporary, file)
}
