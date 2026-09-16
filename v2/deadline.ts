// Hard deadlines for /retitle.
//
// Every request the plugin makes to the local OpenCode server is bounded. A
// request that ignores the abort still cannot hang the plugin: the caller is
// released by the abort listener, and the late settlement of the abandoned
// promise is swallowed so it never surfaces as an unhandled rejection.

export class RetitleTimeoutError extends Error {
  readonly code = "timeout"

  constructor(readonly deadlineMs: number, readonly stage: string) {
    super(`Retitle ${stage} timed out after ${deadlineMs}ms`)
    this.name = "RetitleTimeoutError"
  }
}

export interface Deadline {
  readonly signal: AbortSignal
  readonly ms: number
  /** Aborts early (e.g. a failure in an earlier stage). */
  abort(reason?: unknown): void
  /** Aborted-state and timer release. Safe to call more than once. */
  dispose(): void
}

export function createDeadline(ms: number, stage: string): Deadline {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new RetitleTimeoutError(ms, stage)), ms)
  // Never keep the TUI process alive for a deadline.
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref()
  let disposed = false
  return {
    signal: controller.signal,
    ms,
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason)
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
    },
  }
}

/**
 * Resolves with `work`, or rejects with `RetitleTimeoutError` when the deadline
 * aborts first. `work`'s later settlement is discarded silently.
 */
export function withDeadline<T>(work: Promise<T>, deadline: Deadline): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      deadline.signal.removeEventListener("abort", onAbort)
      deadline.dispose()
      settle()
    }
    const onAbort = () => {
      const reason = deadline.signal.reason
      finish(() =>
        reject(reason instanceof RetitleTimeoutError ? reason : new RetitleTimeoutError(deadline.ms, "request")),
      )
    }
    deadline.signal.addEventListener("abort", onAbort, { once: true })
    if (deadline.signal.aborted) {
      onAbort()
      return
    }
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}
