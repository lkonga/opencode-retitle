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
}

export const DEFAULT_LOG_PATH = "/tmp/opencode-retitle.log"

export function logPath(env: Record<string, string | undefined> = process.env): string {
  return env.OPENCODE_RETITLE_LOG || DEFAULT_LOG_PATH
}

export function createRetitleLogger(options: LoggerOptions = {}): RetitleLogger {
  const now = options.now ?? (() => new Date())
  const target = options.file ?? logPath()
  const write =
    options.write ??
    ((line: string) => {
      try {
        fs.appendFileSync(target, line)
      } catch {}
    })

  return {
    event(name, fields) {
      try {
        const record = { ts: now().toISOString(), source: "v2", event: name, ...sanitizeLogFields(fields ?? {}) }
        write(JSON.stringify(record) + "\n")
      } catch {}
    },
  }
}
