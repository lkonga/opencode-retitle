// Typed failures shared by the /retitle adapter, runner and dialogs.
//
// `code` is a redaction-safe identifier: it is what reaches the log. `message`
// is user-facing and may be shown in a toast, so it never carries transcript
// content — provider/transport text stays in `cause` and is only used to build a
// bounded, human-readable hint.

import { RetitleTimeoutError } from "./deadline"

export type RetitleErrorCode =
  | "unsupported"
  | "helper-create"
  | "generate"
  | "rename"
  | "history"
  | "model"
  | "deadline"
  | "empty"
  | "no-title"

export class RetitleError extends Error {
  constructor(
    readonly code: RetitleErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = "RetitleError"
  }
}

/** Beyond this, an error string is treated as provider noise, not a hint. */
export const MAX_ERROR_HINT_LENGTH = 200

/**
 * Maps any thrown value to a stable code plus a bounded user-facing message.
 * `fallback` is the code used for a plain Error thrown by a stage that has one
 * obvious meaning (e.g. the rename write). Never returns an unbounded provider
 * payload.
 */
export function describeRetitleError(
  error: unknown,
  fallback: RetitleErrorCode = "generate",
): { code: RetitleErrorCode; message: string } {
  if (error instanceof RetitleError) return { code: error.code, message: error.message }
  if (error instanceof RetitleTimeoutError) return { code: "deadline", message: error.message }
  if (error instanceof Error) return { code: fallback, message: bounded(error.message) || "Retitle failed" }
  return { code: fallback, message: "Retitle failed" }
}

export function bounded(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > MAX_ERROR_HINT_LENGTH ? `${trimmed.slice(0, MAX_ERROR_HINT_LENGTH - 3)}...` : trimmed
}
