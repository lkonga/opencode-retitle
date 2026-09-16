// Behavioural tests for the /retitle pipeline: empty, short and long histories,
// provider failure, deadline, unusable output, and the title write.

import { describe, expect, test } from "bun:test"
import { applyRetitleTitle, executeRetitle, type RetitlePorts } from "../runner"
import { RetitleTimeoutError } from "../deadline"
import { RetitleError } from "../errors"
import { MAX_SAMPLE_TEXT_LENGTH } from "../retitle-core"
import type { LogFields, RetitleLogger } from "../logger"
import type { RetitleMessage } from "../retitle-core"

function captureLogger() {
  const events: Array<{ name: string; fields: LogFields }> = []
  const logger: RetitleLogger = {
    event(name, fields = {}) {
      events.push({ name, fields })
    },
  }
  return { logger, events, text: () => JSON.stringify(events) }
}

type Calls = {
  readonly prompts: string[]
  readonly generates: Array<{ sessionID: string; prompt: string; model: unknown }>
  readonly applied: Array<{ sessionID: string; title: string }>
}

function ports(overrides: Partial<RetitlePorts> = {}) {
  const calls: Calls = { prompts: [], generates: [], applied: [] }
  const base: RetitlePorts = {
    loadMessages: async () => [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }],
    resolveModel: async () => ({ providerID: "openai", modelID: "gpt-5" }),
    generateTitle: async (input) => {
      calls.generates.push({ sessionID: input.sessionID, prompt: input.prompt, model: input.model })
      calls.prompts.push(input.prompt)
      return "Deployment pipeline"
    },
    applyTitle: async (sessionID, title) => {
      calls.applied.push({ sessionID, title })
    },
  }
  return { ports: { ...base, ...overrides }, calls }
}

const settings = { samples: 10, offset: 0, fromPct: 100, steering: "", model: "" }

const TRANSCRIPT_MARKER = "USER-SECRET-TRANSCRIPT"

describe("executeRetitle", () => {
  test("reports an empty history without generating", async () => {
    const { ports: p, calls } = ports({ loadMessages: async () => [] })
    const outcome = await executeRetitle(p, { sessionID: "ses_1", settings })
    expect(outcome).toEqual({ status: "empty", messageCount: 0 })
    expect(calls.generates).toEqual([])
  })

  test("retitles from a single short turn", async () => {
    const { ports: p } = ports({
      loadMessages: async () => [{ role: "user", text: "how do I rebase?" }],
    })
    const outcome = await executeRetitle(p, { sessionID: "ses_1", settings })
    expect(outcome).toEqual({
      status: "ok",
      title: "Deployment pipeline",
      model: { providerID: "openai", modelID: "gpt-5" },
    })
  })

  test("keeps a long history bounded and still samples the latest turn", async () => {
    const messages: RetitleMessage[] = []
    for (let index = 0; index < 400; index++) {
      messages.push({ role: "user", text: `turn ${index} ${"x".repeat(500)}` }, { role: "assistant", text: `answer ${index}` })
    }
    const { ports: p, calls } = ports({ loadMessages: async () => messages })

    const outcome = await executeRetitle(p, { sessionID: "ses_1", settings: { ...settings, samples: 5 } })

    expect(outcome.status).toBe("ok")
    const prompt = calls.prompts[0]
    // 5 sampled turns, each bounded, plus the fixed prompt preamble.
    expect(prompt.split("[Turn ").length - 1).toBeLessThanOrEqual(10)
    expect(prompt).toContain("turn 399")
    expect(prompt.length).toBeLessThan(messages.length * MAX_SAMPLE_TEXT_LENGTH)
  })

  test("honours --samples/--offset/--from through the settings object", async () => {
    const messages: RetitleMessage[] = [
      { role: "user", text: "oldest" },
      { role: "assistant", text: "a" },
      { role: "user", text: "newest" },
      { role: "assistant", text: "b" },
    ]
    const { ports: p, calls } = ports({ loadMessages: async () => messages })

    await executeRetitle(p, { sessionID: "ses_1", settings: { ...settings, samples: 3, offset: 2, fromPct: 50 } })

    expect(calls.prompts[0]).toContain("newest")
    expect(calls.prompts[0]).not.toContain("oldest")
  })

  test("maps a provider failure to a bounded outcome and a redaction-safe log", async () => {
    const { logger, events, text } = captureLogger()
    const { ports: p } = ports({
      loadMessages: async () => [{ role: "user", text: TRANSCRIPT_MARKER }],
      generateTitle: async () => {
        throw new Error(`provider echoed ${TRANSCRIPT_MARKER}`)
      },
    })

    const outcome = await executeRetitle(p, { sessionID: "ses_1", settings, logger })

    expect(outcome.status).toBe("error")
    expect(outcome).toMatchObject({ code: "generate" })
    expect(events.some((event) => event.name === "run-error")).toBe(true)
    expect(text()).not.toContain(TRANSCRIPT_MARKER)
  })

  test("maps a deadline to a timeout outcome", async () => {
    const { logger, events } = captureLogger()
    const { ports: p } = ports({
      generateTitle: async () => {
        throw new RetitleTimeoutError(45_000, "generate")
      },
    })

    const outcome = await executeRetitle(p, { sessionID: "ses_1", settings, logger })

    expect(outcome).toMatchObject({ status: "error", code: "deadline" })
    expect(events.some((event) => event.name === "run-timeout")).toBe(true)
  })

  test("maps a model resolution failure to a model outcome", async () => {
    const { ports: p } = ports({
      resolveModel: async () => {
        throw new RetitleError("model", "Connect a provider before using /retitle")
      },
    })
    const outcome = await executeRetitle(p, { sessionID: "ses_1", settings })
    expect(outcome).toMatchObject({ status: "error", code: "model" })
  })

  test("treats empty, whitespace and refusal output as no title", async () => {
    for (const value of [undefined, "", "   ", "I cannot assist with that"]) {
      const { ports: p } = ports({ generateTitle: async () => value })
      const outcome = await executeRetitle(p, { sessionID: "ses_1", settings })
      expect(outcome.status).toBe("no-title")
    }
  })

  test("cleans the generated title before offering it", async () => {
    const { ports: p } = ports({ generateTitle: async () => '"Quoted title"\nignored second line' })
    const outcome = await executeRetitle(p, { sessionID: "ses_1", settings })
    expect(outcome).toEqual({
      status: "ok",
      title: "Quoted title",
      model: { providerID: "openai", modelID: "gpt-5" },
    })
  })

  test("writes the title exactly once after confirmation", async () => {
    const { ports: p, calls } = ports()
    const result = await applyRetitleTitle(p, "ses_1", "Deployment pipeline")
    expect(result).toEqual({ ok: true })
    expect(calls.applied).toEqual([{ sessionID: "ses_1", title: "Deployment pipeline" }])
  })

  test("surfaces a failed title write without throwing", async () => {
    const { ports: p } = ports({
      applyTitle: async () => {
        throw new Error("rename boom")
      },
    })
    const result = await applyRetitleTitle(p, "ses_1", "x")
    expect(result).toMatchObject({ ok: false, code: "rename" })
  })
})
