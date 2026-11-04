// Persisted /retitle settings.
//
// V1 wrote `retitle-config.json` into `$OPENCODE_CONFIG_DIR || ~/.config/opencode`
// (`../tui.ts:33`). V2 must not fall back to the V1 config directory, so this
// module never resolves a config path and never touches the filesystem: it uses
// the host's durable plugin storage (`Plugin.Context.storage`, documented as
// "persisted to disk, survives hot reloads and TUI restarts"), which is
// channel-scoped and lives under the V2 state root — never under the V1 config
// directory. There is therefore no fallback to disable: the code path that
// could reach a V1 file does not exist here.

import {
  DEFAULT_FROM_PCT,
  DEFAULT_OFFSET,
  DEFAULT_SAMPLES,
  parseRetitleArgs,
  type RetitleSettings,
} from "./retitle-core"

export const SETTINGS_KEY = "settings"
import { readContinuous, type RetitleContinuousSettings } from "./continuous-settings"

export type RetitlePersisted = {
  readonly model: string
  readonly continuous?: RetitleContinuousSettings
}

/** Structural view of `Plugin.Context.storage` — only what retitle persists. */
export interface SettingsStorage {
  store<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
}

export interface SettingsStore {
  read(): RetitlePersisted
  setModel(model: string): Promise<void>
  setContinuous?(settings: RetitleContinuousSettings): Promise<void>
}

export function initialSettings(): RetitlePersisted {
  return { model: "" }
}

/** Defensive read: a hand-edited or older state file must not break the plugin. */
export function readPersisted(value: unknown): RetitlePersisted {
  if (!value || typeof value !== "object") return initialSettings()
  const model = (value as { readonly model?: unknown }).model
  const continuous = (value as { continuous?: unknown }).continuous
  return { model: typeof model === "string" ? model.trim() : "",
    ...(continuous === undefined ? {} : { continuous: readContinuous(continuous) }) }
}

export function createSettingsStore(storage: SettingsStorage): SettingsStore {
  const [store, update] = storage.store<RetitlePersisted>(SETTINGS_KEY, { initial: initialSettings() })
  return {
    read: () => readPersisted(store),
    setModel: (model) => update((draft) => void (draft.model = model.trim())),
    setContinuous: (settings) => update((draft) => void (draft.continuous = readContinuous(settings))),
  }
}

/** Dialog defaults plus the persisted model override. */
export function defaultSettings(persisted: RetitlePersisted): RetitleSettings {
  return {
    samples: DEFAULT_SAMPLES,
    offset: DEFAULT_OFFSET,
    fromPct: DEFAULT_FROM_PCT,
    steering: "",
    model: persisted.model,
  }
}

/**
 * Seeds a fresh settings object from the raw `/retitle ...` argument string.
 * `--samples/--offset/--from` are honoured here; the remaining text is the
 * steering hint, exactly as V1's dialog options were seeded.
 */
export function settingsFromArgs(persisted: RetitlePersisted, rawArgs?: string): RetitleSettings {
  const settings = defaultSettings(persisted)
  const parsed = parseRetitleArgs(rawArgs)
  if (parsed.steeringHint) settings.steering = parsed.steeringHint
  if (parsed.samplingOptions?.maxSamples !== undefined) settings.samples = parsed.samplingOptions.maxSamples
  if (parsed.samplingOptions?.offset !== undefined) settings.offset = parsed.samplingOptions.offset
  if (parsed.samplingOptions?.fromPercent !== undefined) settings.fromPct = parsed.samplingOptions.fromPercent
  return settings
}
