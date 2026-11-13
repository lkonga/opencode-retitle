// Redacted event log for /retitle.
//
// Requirement: never log the conversation transcript, tool payloads, the title
// prompt, or generated model text. The log is a diagnostic trail of *events*
// and *sizes*, nothing else.
//
// The redaction is enforced structurally, not by caller discipline: every field
// goes through `sanitizeLogFields`, which drops content-bearing keys and
// collapses long strings. A caller that accidentally passes a provider error
// message — which can echo the prompt back — cannot leak it.

import fs from "node:fs"
import { dlopen, FFIType } from "bun:ffi"

export type LogValue = string | number | boolean | null | undefined
export type LogFields = Readonly<Record<string, LogValue | unknown>>

/** Keys whose value is conversation content by definition, dropped outright. */
const CONTENT_KEYS = new Set([
  "text",
  "message",
  "prompt",
  "content",
  "transcript",
  "tool",
  "tools",
  "args",
  "arguments",
  "payload",
  "body",
  "result",
  "input",
  "output",
  "title",
  "steering",
  "hint",
  "stack",
])

/** Errors are reduced to a name and a length, never logged verbatim. */
function errorInfo(value: unknown): { name: string; length?: number } | undefined {
  if (!value) return undefined
  if (typeof value === "string") return { name: "Error", length: value.length }
  if (typeof value !== "object") return { name: typeof value }
  const record = value as { readonly name?: unknown; readonly message?: unknown }
  const name = typeof record.name === "string" && record.name ? record.name : "Error"
  return { name, ...(typeof record.message === "string" ? { length: record.message.length } : {}) }
}

/** Anything past this is content-sized (provider errors echo the prompt). */
export const MAX_LOG_VALUE_LENGTH = 80

/**
 * Drops content keys, collapses long strings to `<redacted:len>`, and replaces
 * non-scalar values with a JSON size marker. Never throws on hostile input.
 */
export function sanitizeLogFields(fields: LogFields): Record<string, LogValue> {
  const result: Record<string, LogValue> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (CONTENT_KEYS.has(key)) continue
    if (key === "error") {
      const info = errorInfo(value)
      if (info) {
        result.errorName = info.name
        if (info.length !== undefined) result.errorLength = info.length
      }
      continue
    }
    if (value === undefined || value === null) continue
    if (typeof value === "number" || typeof value === "boolean") {
      result[key] = value
      continue
    }
    if (typeof value === "string") {
      result[key] = value.length > MAX_LOG_VALUE_LENGTH ? `<redacted:${value.length}>` : value
      continue
    }
    result[key] = `<redacted:${typeof value}>`
  }
  return result
}

export interface RetitleLogger {
  event(name: string, fields?: LogFields): void
}

export interface LoggerOptions {
  /** Destination file. Defaults to `$OPENCODE_RETITLE_LOG` or the V1 log path. */
  readonly file?: string
  /** Replace the file append (tests). Defaults to a synchronous append. */
  readonly write?: (line: string) => void
  readonly now?: () => Date
  readonly debug?: boolean
  readonly enabled?: boolean
  readonly maxBytes?: number
  readonly backups?: number
}

export const DEFAULT_LOG_PATH = "/tmp/opencode-retitle.log"

export function logPath(env: Record<string, string | undefined> = process.env): string {
  return env.OPENCODE_RETITLE_LOG || DEFAULT_LOG_PATH
}

export function createRetitleLogger(options: LoggerOptions = {}): RetitleLogger {
  const now = options.now ?? (() => new Date())
  const target = options.file ?? logPath()
  const debug = options.debug ?? process.env.OPENCODE_RETITLE_DEBUG === "1"
  const enabled = options.enabled ?? process.env.OPENCODE_RETITLE_LOG_ENABLED !== "0"
  const maxBytes = boundedNumber(options.maxBytes ?? Number(process.env.OPENCODE_RETITLE_LOG_MAX_BYTES), 1048576, 1024, 1048576)
  const backups = boundedNumber(options.backups ?? Number(process.env.OPENCODE_RETITLE_LOG_BACKUPS), 3, 0, 3)
  const write =
    options.write ??
    ((line: string) => {
      try {
        // Keep this inode permanently: the kernel releases flock on process death.
        // Never unlink the lockfile, which would allow two locked inodes at once.
        const flock = getFlock()
        if (!flock) return
        const lock = fs.openSync(`${target}.lockfile`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600)
        try {
          if (!fs.fstatSync(lock).isFile()) return
          fs.fchmodSync(lock, 0o600)
          if (flock(lock, 2 | 4) !== 0) return // LOCK_EX | LOCK_NB
          for (let i = backups + 1; i <= 3; i++) {
            const path = `${target}.${i}`
            try {
              if (!fs.lstatSync(path).isFile()) return
              fs.unlinkSync(path)
            } catch (error: any) { if (error?.code !== "ENOENT") return }
          }
          for (let i = 0; i <= backups; i++) {
            const path = i ? `${target}.${i}` : target
            try {
              const st = fs.lstatSync(path)
              if (!st.isFile() || st.isSymbolicLink()) return
              fs.chmodSync(path, 0o600)
              if (st.size > maxBytes) fs.truncateSync(path, 0)
            } catch (error: any) { if (error?.code !== "ENOENT") return }
          }
          let size = 0
          try { size = fs.statSync(target).size } catch (error: any) { if (error?.code !== "ENOENT") return }
          if (size + Buffer.byteLength(line) > maxBytes) {
            if (backups) {
              for (let i = backups; i > 1; i--) {
                try { fs.renameSync(`${target}.${i - 1}`, `${target}.${i}`) } catch (error: any) { if (error?.code !== "ENOENT") return }
              }
              try { fs.renameSync(target, `${target}.1`) } catch (error: any) { if (error?.code !== "ENOENT") return }
            } else {
              try { fs.unlinkSync(target) } catch (error: any) { if (error?.code !== "ENOENT") return }
            }
          }
          const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600)
          try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, line) } finally { fs.closeSync(fd) }
        } finally { fs.closeSync(lock) }
      } catch {}
    })

  return {
    event(name, fields) {
      try {
        if (!enabled || (!debug && !DEFAULT_EVENTS.has(name))) return
        const sanitized = sanitizeLogFields(fields ?? {})
        const safe: Record<string, LogValue> = {}
        for (const key of SAFE_FIELDS) {
          const value = sanitized[key]
          if (typeof value === "number" || typeof value === "boolean") safe[key] = value
          else if (typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,80}$/.test(value)) safe[key] = value
        }
        // Error names are attacker-controlled too; never serialize them.
        if ("errorName" in safe) safe.errorName = "Error"
        let line = JSON.stringify({ ts: now().toISOString(), source: "v2", event: name, ...safe }) + "\n"
        if (Buffer.byteLength(line) > Math.min(maxBytes, 4096)) line = JSON.stringify({ ts: now().toISOString(), source: "v2", event: "oversize-event" }) + "\n"
        write(line)
      } catch {}
    },
  }
}

const DEFAULT_EVENTS = new Set(["batch-start", "batch-end", "batch-session-result", "batch-session-skipped", "batch-rejected", "batch-no-tabs", "batch-worker-error", "auto-apply", "applied", "auto-error", "outcome-empty", "outcome-no-title", "outcome-error", "run-error", "run-timeout", "title-apply-error", "title-update-error", "session-refresh-error", "history-error", "history-unsupported", "no-title", "generate-truncated", "generate-error", "helper-create-error", "helper-remove-error", "settings-store-error", "settings-write-error", "adapter-read-error", "command-error", "progress-show-error", "progress-clear-error", "no-session", "rejected"])
const SAFE_FIELDS = new Set(["sessionID", "helperSessionID", "batchID", "status", "reason", "code", "stage", "operation", "model", "providerID", "modelID", "errorName", "errorLength", "timedOut", "durationMs", "total", "updated", "skipped", "failed", "messageCount", "titleLength"])

function boundedNumber(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) && value >= min ? Math.min(max, Math.floor(value)) : fallback
}

let flockFunction: ((fd: number, operation: number) => number) | null | undefined
function getFlock(): ((fd: number, operation: number) => number) | null {
  if (flockFunction !== undefined) return flockFunction
  try {
    const libc = process.platform === "linux" ? "libc.so.6" : process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : ""
    if (!libc) return (flockFunction = null)
    // Keep the loaded library alive for the lifetime of the function.
    const library = dlopen(libc, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
    return (flockFunction = (fd, operation) => library.symbols.flock(fd, operation))
  } catch { return (flockFunction = null) }
}
