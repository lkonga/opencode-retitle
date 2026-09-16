import { describe, expect, test } from "bun:test"
import {
  buildModelOptions,
  cleanTitle,
  isModelAvailable,
  MAX_GENERATED_TEXT_LENGTH,
  modelKey,
  normalizeCreatedSessionID,
  normalizeGeneratedText,
  normalizeMessagePage,
  normalizeMessages,
  parseModelString,
  parseRetitleArgs,
  pickModel,
  sampleTurns,
  settingsToArgs,
  titlePrompt,
  type RetitleMessage,
} from "../retitle-core"

const user = (text: string): RetitleMessage => ({ role: "user", text })
const assistant = (text: string, model?: { providerID: string; modelID: string }): RetitleMessage => ({
  role: "assistant",
  text,
  ...(model ? { model } : {}),
})

describe("parseRetitleArgs", () => {
  test("returns empty for no input", () => {
    expect(parseRetitleArgs()).toEqual({})
    expect(parseRetitleArgs("   ")).toEqual({})
  })

  test("parses flags and keeps the remaining hint", () => {
    expect(parseRetitleArgs("--samples 20 --from 50 docker setup")).toEqual({
      steeringHint: "docker setup",
      samplingOptions: { maxSamples: 20, fromPercent: 50, offset: undefined },
    })
  })

  test("clamps samples and from, floors offset", () => {
    expect(parseRetitleArgs("--samples 999 --from 500 --offset 0")).toEqual({
      steeringHint: undefined,
      samplingOptions: { maxSamples: 50, fromPercent: 100, offset: 1 },
    })
  })
})

describe("settingsToArgs", () => {
  test("emits only non-default flags plus the hint", () => {
    expect(settingsToArgs({ samples: 10, offset: 0, fromPct: 100, steering: "", model: "" })).toBe("")
    expect(settingsToArgs({ samples: 20, offset: 30, fromPct: 50, steering: "k8s", model: "" })).toBe(
      "--samples 20 --offset 30 --from 50 k8s",
    )
  })
})

describe("normalizeMessages", () => {
  test("projects user text and assistant content, skipping other roles", () => {
    const result = normalizeMessages([
      { type: "agent-selected" },
      { type: "user", text: "hello" },
      { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "hi" }], model: { id: "m", providerID: "p" } },
      { type: "synthetic", text: "ignored" },
      { type: "assistant", content: [] },
    ])
    expect(result).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi", model: { providerID: "p", modelID: "m" }, error: undefined },
      { role: "assistant", text: "", model: undefined, error: undefined },
    ])
  })

  test("surfaces assistant errors", () => {
    const result = normalizeMessages([{ type: "assistant", content: [], error: { message: "boom" } }])
    expect(result[0].error).toBe("boom")
  })
})

describe("sampleTurns", () => {
  test("pairs each sampled user turn with the following assistant text", () => {
    const messages: RetitleMessage[] = [user("first"), assistant("first answer"), user("second"), assistant("second answer")]
    const sampled = sampleTurns(messages)
    expect(sampled).toEqual([
      { index: 0, role: "user", text: "first" },
      { index: 0, role: "assistant", text: "first answer" },
      { index: 1, role: "user", text: "second" },
      { index: 1, role: "assistant", text: "second answer" },
    ])
  })

  test("returns empty when no user turns exist", () => {
    expect(sampleTurns([assistant("only")])).toEqual([])
  })

  test("caps samples and keeps the tail of a long conversation", () => {
    const messages: RetitleMessage[] = []
    for (let i = 0; i < 30; i++) messages.push(user(`turn ${i}`), assistant(`answer ${i}`))
    const sampled = sampleTurns(messages, { maxSamples: 5 })
    const turns = sampled.filter((message) => message.role === "user")
    expect(turns.length).toBeLessThanOrEqual(5)
    expect(turns.at(-1)?.text).toBe("turn 29")
  })

  test("honours the offset window", () => {
    const messages: RetitleMessage[] = [user("old"), assistant("old answer"), user("new"), assistant("new answer")]
    const sampled = sampleTurns(messages, { offset: 2, maxSamples: 10 })
    const turns = sampled.filter((message) => message.role === "user")
    expect(turns.map((turn) => turn.text)).toEqual(["new"])
  })

  test("truncates long sampled text", () => {
    const sampled = sampleTurns([user("x".repeat(400))], { maxSamples: 3 })
    expect(sampled[0].text.length).toBe(203)
    expect(sampled[0].text.endsWith("...")).toBe(true)
  })
})

describe("titlePrompt", () => {
  test("includes turn labels and the steering hint", () => {
    const prompt = titlePrompt([{ index: 0, role: "user", text: "hi" }], "be terse")
    expect(prompt).toContain("[Turn 1 user]: hi")
    expect(prompt).toContain("be terse")
    expect(prompt).toContain("14 words or fewer")
  })
})

describe("cleanTitle", () => {
  test("strips think tags and quotes", () => {
    expect(cleanTitle("hello world")).toBe("hello world")
    expect(cleanTitle('"quoted title"')).toBe("quoted title")
    expect(cleanTitle("a<think>hidden</think>b")).toBe("ab")
  })

  test("keeps V1 regex precedence for the <thinking> variant", () => {
    // V1 applies the `<think...` rule before the `<thinking...` rule, so the
    // unterminated-think branch swallows the rest of the line. Preserved 1:1.
    expect(cleanTitle("before<thinking>hidden</thinking>after")).toBe("before")
  })

  test("returns undefined for refusals and empty output", () => {
    expect(cleanTitle("I cannot assist with that")).toBeUndefined()
    expect(cleanTitle("   ")).toBeUndefined()
  })

  test("caps the title at 100 characters", () => {
    const title = cleanTitle("a".repeat(150))
    expect(title?.length).toBe(100)
    expect(title?.endsWith("...")).toBe(true)
  })
})

describe("model helpers", () => {
  test("parses provider/model strings", () => {
    expect(parseModelString("anthropic/claude")).toEqual({ providerID: "anthropic", modelID: "claude" })
    expect(parseModelString("noslash")).toBeUndefined()
    expect(parseModelString("/leading")).toBeUndefined()
    expect(parseModelString("trailing/")).toBeUndefined()
  })

  test("pickModel follows override -> title agent -> session -> message -> catalog", () => {
    const messages = [assistant("a", { providerID: "msg", modelID: "m" })]
    const available = [{ id: "first", providerID: "catalog" }]

    expect(pickModel({ override: "over/ride", agentModel: { id: "agent", providerID: "p" }, messages, available })?.providerID).toBe("over")
    expect(pickModel({ agentModel: { id: "agent", providerID: "p" }, messages, available })).toEqual({ providerID: "p", modelID: "agent" })
    expect(pickModel({ sessionModel: { id: "sess", providerID: "s" }, messages, available })).toEqual({ providerID: "s", modelID: "sess" })
    expect(pickModel({ messages, available })).toEqual({ providerID: "msg", modelID: "m" })
    expect(pickModel({ available })).toEqual({ providerID: "catalog", modelID: "first" })
    expect(pickModel({ available: [] })).toBeUndefined()
  })

  test("catalog fallback skips disabled and deprecated models", () => {
    const available = [
      { id: "old", providerID: "p", status: "deprecated" },
      { id: "off", providerID: "p", enabled: false },
      { id: "ok", providerID: "p" },
    ]
    expect(pickModel({ available })).toEqual({ providerID: "p", modelID: "ok" })
  })

  test("modelKey and isModelAvailable", () => {
    expect(modelKey({ providerID: "p", modelID: "m" })).toBe("p/m")
    expect(isModelAvailable({ providerID: "p", modelID: "m" }, [{ id: "m", providerID: "p" }])).toBe(true)
    expect(isModelAvailable({ providerID: "p", modelID: "n" }, [{ id: "m", providerID: "p" }])).toBe(false)
  })

  test("buildModelOptions lists auto first when nothing is selected", () => {
    const options = buildModelOptions([{ id: "m1", providerID: "p1", name: "Model One" }], [{ id: "p1", name: "Provider One" }], "")
    expect(options[0].value).toBe("")
    expect(options[0].category).toBe("Default")
  })

  test("buildModelOptions marks the current model and skips deprecated ones", () => {
    const options = buildModelOptions(
      [
        { id: "m1", providerID: "p1", name: "Model One" },
        { id: "m2", providerID: "p1", name: "Model Two", status: "deprecated" },
      ],
      [{ id: "p1", name: "Provider One" }],
      "p1/m1",
    )
    // V1 sorts the current value to the very top, ahead of the auto option.
    expect(options[0].value).toBe("p1/m1")
    const values = options.map((option) => option.value)
    expect(values).toContain("")
    expect(values).not.toContain("p1/m2")
    expect(options.find((option) => option.value === "p1/m1")?.description).toBe("← current")
    expect(options.find((option) => option.value === "p1/m1")?.category).toBe("Provider One")
  })
})

describe("public API result normalization", () => {
  test("normalizeGeneratedText accepts the known envelopes and rejects the rest", () => {
    expect(normalizeGeneratedText("bare")).toBe("bare")
    expect(normalizeGeneratedText({ text: "unwrapped" })).toBe("unwrapped")
    expect(normalizeGeneratedText({ data: { text: "wrapped" } })).toBe("wrapped")
    expect(normalizeGeneratedText("  padded  ")).toBe("padded")

    for (const value of [undefined, null, 42, {}, { text: 5 }, { data: {} }, { data: { text: 5 } }, "   ", []]) {
      expect(normalizeGeneratedText(value)).toBeUndefined()
    }
  })

  test("normalizeGeneratedText bounds an unbounded result", () => {
    const result = normalizeGeneratedText("x".repeat(MAX_GENERATED_TEXT_LENGTH * 3))
    expect(result?.length).toBe(MAX_GENERATED_TEXT_LENGTH)
  })

  test("normalizeMessagePage tolerates a page, a bare array, and garbage", () => {
    const page = [{ type: "user", text: "hi" }]
    expect(normalizeMessagePage({ data: page, cursor: {} })).toEqual(page)
    expect(normalizeMessagePage(page)).toEqual(page)
    expect(normalizeMessagePage(undefined)).toEqual([])
    expect(normalizeMessagePage({ data: null })).toEqual([])
    expect(normalizeMessagePage("nope")).toEqual([])
  })

  test("normalizeCreatedSessionID reads both envelopes and rejects malformed values", () => {
    expect(normalizeCreatedSessionID({ id: "ses_1" })).toBe("ses_1")
    expect(normalizeCreatedSessionID({ data: { id: "ses_2" } })).toBe("ses_2")
    expect(normalizeCreatedSessionID("ses_3")).toBe("ses_3")
    for (const value of [undefined, null, {}, { id: 5 }, { id: "" }, { data: { id: 7 } }, 42]) {
      expect(normalizeCreatedSessionID(value)).toBeUndefined()
    }
  })
})
