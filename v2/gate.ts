// Run gate and failure-toast debounce for /retitle.
//
// The gate is the single source of truth for "one retitle at a time". It is
// deliberately synchronous: `begin()` claims the slot before the first `await`
// in the caller, so two invocations that race on the same tick cannot both win.
// Combined with the helper-session cleanup in `session-api.ts` this is what
// keeps /retitle free of duplicated helpers, duplicated dialogs and duplicate
// title writes.

export type GateRejection = "in-flight" | "debounced"

export type GateGrant = { readonly ok: true; readonly token: symbol }
export type GateDenial = { readonly ok: false; readonly reason: GateRejection }
export type GateResult = GateGrant | GateDenial

export interface RunGate {
  begin(): GateResult
  /** Releases the slot. A token that is not current is ignored. */
  end(token: symbol): void
  /** True while a run holds the slot. */
  running(): boolean
}

export interface GateOptions {
  /**
   * Window after a successful `begin()` during which further `begin()` calls
   * are rejected as double submits (two Enters, palette + slash, a key repeat).
   * Measured from the claim, not from release, so cancelling a dialog and
   * invoking again immediately afterwards still works.
   */
  readonly debounceMs?: number
  /** Injectable clock for tests. */
  readonly now?: () => number
}

export const DEFAULT_DEBOUNCE_MS = 400

export function createRunGate(options: GateOptions = {}): RunGate {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const now = options.now ?? (() => Date.now())
  let current: symbol | undefined
  let lastBeginAt = Number.NEGATIVE_INFINITY

  return {
    begin() {
      if (current !== undefined) return { ok: false, reason: "in-flight" }
      if (now() - lastBeginAt < debounceMs) return { ok: false, reason: "debounced" }
      const token = Symbol("retitle-run")
      current = token
      lastBeginAt = now()
      return { ok: true, token }
    },
    end(token) {
      if (current !== token) return
      current = undefined
    },
    running() {
      return current !== undefined
    },
  }
}

/**
 * Keyed debouncer for repeated failure toasts: the same failure key inside the
 * window is suppressed so a model that fails every attempt cannot fill the
 * screen. Different keys always pass.
 */
export interface Debouncer {
  /** True when this call emits; false when it is suppressed. */
  allow(key: string): boolean
}

export function createDebouncer(options: { readonly windowMs: number; readonly now?: () => number }): Debouncer {
  const now = options.now ?? (() => Date.now())
  let lastKey: string | undefined
  let lastAt = Number.NEGATIVE_INFINITY

  return {
    allow(key) {
      if (key === lastKey && now() - lastAt < options.windowMs) return false
      lastKey = key
      lastAt = now()
      return true
    },
  }
}
