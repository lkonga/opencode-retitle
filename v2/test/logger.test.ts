// Behavioural tests for the log redaction: no transcript, no prompt, no tool
// payload, no unbounded provider text ever reaches the log file.

import { describe, expect, test } from "bun:test"
import { createRetitleLogger, sanitizeLogFields, logPath, MAX_LOG_VALUE_LENGTH, DEFAULT_LOG_PATH } from "../logger"

describe("sanitizeLogFields", () => {
  test("drops content-bearing keys", () => {
    const result = sanitizeLogFields({
      sessionID: "ses_1",
      text: "user transcript",
      message: "provider message",
      prompt: "the whole prompt",
      content: [{ type: "text", text: "assistant text" }],
      transcript: "everything",
      tool: "bash",
      tools: [{ name: "bash" }],
      args: { command: "rm -rf /" },
      payload: { a: 1 },
      body: { b: 2 },
      result: "tool output",
      input: "tool input",
      output: "tool output",
      title: "generated title",
      steering: "hint text",
      hint: "hint text",
      stack: "at foo",
    })

    expect(result).toEqual({ sessionID: "ses_1" })
  })

  test("keeps scalar diagnostics and redacts oversized strings", () => {
    const long = "x".repeat(MAX_LOG_VALUE_LENGTH + 20)
    const result = sanitizeLogFields({
      messageCount: 12,
      sampledCount: 5,
      hasOverride: true,
      offset: null,
      note: "short",
      providerError: long,
    })

    expect(result).toEqual({
      messageCount: 12,
      sampledCount: 5,
      hasOverride: true,
      note: "short",
      providerError: `<redacted:${long.length}>`,
    })
    expect(JSON.stringify(result)).not.toContain(long)
  })

  test("reduces errors to a name and a length", () => {
    const alone = sanitizeLogFields({ error: new Error("provider echoed USER-SECRET-TRANSCRIPT") })
    expect(alone).toEqual({ errorName: "Error", errorLength: 38 })
    expect(JSON.stringify(alone)).not.toContain("USER-SECRET")

    expect(sanitizeLogFields({ error: "boom" })).toEqual({ errorName: "Error", errorLength: 4 })
    expect(sanitizeLogFields({ error: undefined })).toEqual({})
    expect(sanitizeLogFields({ error: 42 })).toEqual({ errorName: "number" })
  })

  test("never throws on hostile values", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const result = sanitizeLogFields({
      circular,
      fn: () => {},
      symbol: Symbol("x"),
      big: 10n,
      undef: undefined,
    })
    expect(result.circular).toBe("<redacted:object>")
    expect(result.fn).toBe("<redacted:function>")
    expect(result.symbol).toBe("<redacted:symbol>")
    expect(result.big).toBe("<redacted:bigint>")
    expect(result.undef).toBeUndefined()
  })
})

describe("createRetitleLogger", () => {
  test("writes one JSON line per event with the v2 provenance", () => {
    const lines: string[] = []
    const logger = createRetitleLogger({ file: "/tmp/test.log", write: (line) => lines.push(line), now: () => new Date(0) })

    logger.event("run-start", { sessionID: "ses_1", hasOverride: true })
    logger.event("title-ready", { sessionID: "ses_1", titleLength: 12 })

    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0])
    expect(first).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      source: "v2",
      event: "run-start",
      sessionID: "ses_1",
      hasOverride: true,
    })
  })

  test("drops transcript content passed by an over-eager caller", () => {
    const lines: string[] = []
    const logger = createRetitleLogger({ write: (line) => lines.push(line) })

    logger.event("generate-error", {
      helperSessionID: "ses_helper",
      error: new Error("provider echoed USER-SECRET-TRANSCRIPT"),
      message: "USER-SECRET-TRANSCRIPT",
      text: "USER-SECRET-TRANSCRIPT",
    })

    const output = lines.join("")
    expect(output).toContain("generate-error")
    expect(output).not.toContain("USER-SECRET-TRANSCRIPT")
  })

  test("resolves the log path from the environment like V1", () => {
    expect(logPath({})).toBe(DEFAULT_LOG_PATH)
    expect(logPath({ OPENCODE_RETITLE_LOG: "/tmp/custom.log" })).toBe("/tmp/custom.log")
  })

  test("never resolves a log path out of the V1 config environment", () => {
    // V1 read its settings from `$OPENCODE_CONFIG_DIR || ~/.config/opencode`.
    // The V2 log path is independent of it: neither variable can move the log
    // away from the plugin's own path or the /tmp default.
    expect(logPath({ OPENCODE_CONFIG_DIR: "/home/someone/.config/opencode" })).toBe(DEFAULT_LOG_PATH)
    expect(logPath({ OPENCODE_CONFIG_DIR: "/x", HOME: "/home/someone", XDG_CONFIG_HOME: "/home/someone/.config" })).toBe(
      DEFAULT_LOG_PATH,
    )
    expect(logPath({ OPENCODE_RETITLE_LOG: "/tmp/custom.log", OPENCODE_CONFIG_DIR: "/x" })).toBe("/tmp/custom.log")
  })
})
