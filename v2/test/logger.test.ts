// Behavioural tests for the log redaction: no transcript, no prompt, no tool
// payload, no unbounded provider text ever reaches the log file.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
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
    const logger = createRetitleLogger({ debug: true, file: "/tmp/test.log", write: (line) => lines.push(line), now: () => new Date(0) })

    logger.event("run-start", { sessionID: "ses_1", hasOverride: true })
    logger.event("title-ready", { sessionID: "ses_1", titleLength: 12 })

    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0])
    expect(first).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      source: "v2",
      event: "run-start",
      sessionID: "ses_1",
    })
  })

  test("filters normal progress, supports debug and disable, and never leaks arbitrary fields", () => {
    const lines: string[] = []
    const write = (line: string) => lines.push(line)
    createRetitleLogger({ write }).event("progress-shown", { sessionID: "ses_1" })
    createRetitleLogger({ write, enabled: false }).event("auto-apply", {})
    createRetitleLogger({ write }).event("auto-error", { sessionID: "ses_1", authorization: "secret", error: { name: "secret", message: "secret" } })
    createRetitleLogger({ write, debug: true }).event("progress-shown", {})
    expect(lines).toHaveLength(2)
    expect(lines.join("")).not.toContain("secret")
  })

  test("oversize UTF-8 events are replaced with a bounded valid JSON record", () => {
    const lines: string[] = []
    createRetitleLogger({ debug: true, maxBytes: 1024, write: (line) => lines.push(line) }).event("🦆".repeat(1000))
    expect(Buffer.byteLength(lines[0])).toBeLessThanOrEqual(1024)
    expect(JSON.parse(lines[0]).event).toBe("oversize-event")
  })

  test("rotates bounded UTF-8 records, protects files and contains IO errors", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retitle-test-"))
    try {
      const file = path.join(dir, "log")
      const logger = createRetitleLogger({ file, maxBytes: 1024, backups: 3 })
      for (let i = 0; i < 200; i++) logger.event("auto-apply", { sessionID: `ses_${i}` })
      const files = fs.readdirSync(dir).filter((name) => name !== "log.lockfile")
      expect(files.length).toBeLessThanOrEqual(4)
      for (const name of files) {
        const p = path.join(dir, name)
        expect(fs.statSync(p).size).toBeLessThanOrEqual(1024)
        expect(fs.statSync(p).mode & 0o777).toBe(0o600)
        for (const line of fs.readFileSync(p, "utf8").trim().split("\n")) JSON.parse(line)
      }
      expect(() => createRetitleLogger({ file: path.join(dir, "absent", "log") }).event("auto-error", {})).not.toThrow()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test("multiple processes serialize rotation without corrupt records or exceeding retention", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retitle-multi-"))
    try {
      const file = path.join(dir, "log")
      const module = path.resolve(import.meta.dir, "../logger.ts")
      const script = `import { createRetitleLogger } from ${JSON.stringify(module)}; const l=createRetitleLogger({file:process.argv[1],maxBytes:1024,backups:3}); for(let i=0;i<300;i++) l.event('auto-apply',{sessionID:'ses_'+process.pid+'_'+i});`
      const children = Array.from({ length: 4 }, () => spawn(process.execPath, ["-e", script, file], { stdio: "ignore" }))
      expect(await Promise.all(children.map((child) => new Promise((resolve) => child.on("exit", resolve))))).toEqual([0, 0, 0, 0])
      const files = fs.readdirSync(dir).filter((name) => name !== "log.lockfile")
      expect(files.length).toBeLessThanOrEqual(4)
      expect(files.length).toBeGreaterThan(0)
      for (const name of files) {
        const p = path.join(dir, name)
        expect(fs.statSync(p).size).toBeLessThanOrEqual(1024)
        for (const line of fs.readFileSync(p, "utf8").trim().split("\n")) expect(JSON.parse(line).event).toBe("auto-apply")
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test("kernel lock drops contended events and recovers automatically after writer crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retitle-lock-"))
    const file = path.join(dir, "log")
    const script = `import fs from 'node:fs'; import {dlopen, FFIType} from 'bun:ffi'; const fd=fs.openSync(process.argv[1]+'.lockfile','a',0o600); const lib=dlopen('libc.so.6',{flock:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32}}); if(lib.symbols.flock(fd,6)!==0) process.exit(2); console.log('locked'); process.stdin.resume();`
    const child = spawn(process.execPath, ["-e", script, file], { stdio: ["pipe", "pipe", "ignore"] })
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve())
        child.once("exit", () => reject(new Error("lock holder exited early")))
      })
      const logger = createRetitleLogger({ file })
      logger.event("auto-apply", { sessionID: "ses_live" })
      expect(fs.existsSync(file)).toBe(false)
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill("SIGKILL")
      await exited
      logger.event("auto-apply", { sessionID: "ses_after" })
      expect(fs.readFileSync(file, "utf8")).toContain("ses_after")
    } finally { child.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test.each([0, 1])("reducing retention to %i removes only managed backups and caps old files", (backups) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retitle-retention-"))
    try {
      const file = path.join(dir, "log")
      for (const suffix of ["", ".1", ".2", ".3"]) fs.writeFileSync(file + suffix, "x".repeat(2048))
      fs.writeFileSync(file + ".other", "leave alone")
      createRetitleLogger({ file, maxBytes: 1024, backups }).event("auto-apply", { sessionID: "ses_1" })
      expect(fs.readFileSync(file + ".other", "utf8")).toBe("leave alone")
      for (let i = 1; i <= 3; i++) {
        expect(fs.existsSync(`${file}.${i}`)).toBe(i <= backups)
        if (i <= backups) expect(fs.statSync(`${file}.${i}`).size).toBeLessThanOrEqual(1024)
      }
      expect(fs.statSync(file).size).toBeLessThanOrEqual(1024)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test("keeps actual progress failures and suppresses normal progress", () => {
    const lines: string[] = []
    const logger = createRetitleLogger({ write: (line) => lines.push(line) })
    for (const event of ["progress-show-error", "progress-clear-error", "history-unsupported", "no-title", "progress-shown"]) logger.event(event)
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["progress-show-error", "progress-clear-error", "history-unsupported", "no-title"])
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
