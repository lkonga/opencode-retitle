// Behavioural tests for the run gate and the toast debouncer: one run at a
// time, double-submit suppression, token-scoped release, and toast throttling.

import { describe, expect, test } from "bun:test"
import { createDebouncer, createRunGate, DEFAULT_DEBOUNCE_MS } from "../gate"

describe("createRunGate", () => {
  test("grants one run at a time and rejects a concurrent claim as in-flight", () => {
    const gate = createRunGate({ now: () => 1_000 })

    const first = gate.begin()
    expect(first.ok).toBe(true)
    expect(gate.running()).toBe(true)

    // Same tick, no awaits: a second /retitle cannot slip through.
    expect(gate.begin()).toEqual({ ok: false, reason: "in-flight" })
  })

  test("suppresses a double submit inside the debounce window and allows it after", () => {
    let now = 0
    const gate = createRunGate({ now: () => now })

    const first = gate.begin()
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error("unreachable")
    gate.end(first.token)

    expect(gate.begin()).toEqual({ ok: false, reason: "debounced" })

    now += DEFAULT_DEBOUNCE_MS
    expect(gate.begin().ok).toBe(true)
  })

  test("ignores a release from a token that is not current", () => {
    let now = 0
    const gate = createRunGate({ now: () => now })
    const first = gate.begin()
    if (!first.ok) throw new Error("unreachable")

    gate.end(Symbol("stale"))

    expect(gate.running()).toBe(true)
    gate.end(first.token)
    expect(gate.running()).toBe(false)
  })

  test("releases exactly once, so a later run is granted after the window", () => {
    let now = 0
    const gate = createRunGate({ now: () => now })
    const first = gate.begin()
    if (!first.ok) throw new Error("unreachable")
    gate.end(first.token)
    gate.end(first.token)

    now += DEFAULT_DEBOUNCE_MS + 1
    const second = gate.begin()
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error("unreachable")
    expect(gate.running()).toBe(true)
  })
})

describe("createDebouncer", () => {
  test("throttles repeated keys and lets new keys through", () => {
    let now = 0
    const debouncer = createDebouncer({ windowMs: 100, now: () => now })

    expect(debouncer.allow("error:generate:openai/gpt-5")).toBe(true)
    expect(debouncer.allow("error:generate:openai/gpt-5")).toBe(false)
    expect(debouncer.allow("error:deadline:openai/gpt-5")).toBe(true)
    expect(debouncer.allow("error:generate:openai/gpt-5")).toBe(true)

    now += 101
    expect(debouncer.allow("error:deadline:openai/gpt-5")).toBe(true)
  })
})
