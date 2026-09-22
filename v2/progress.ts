// Visible, non-blocking progress feedback for /retitle.
//
// `toast.show` has no dismiss handle, so it cannot represent "work in progress"
// (a toast that lingers after the run is a stuck UI, and one that expires early
// is a lie). The documented dialog surface can: `context.ui.dialog.show(render)`
// renders and `context.ui.dialog.clear()` dismisses. The pinned `Dialog`
// interface is `show(render, onClose?) / set(DialogOptions) / clear()`
// (`packages/plugin/src/tui/context.ts:341-352`) — note that `set` carries
// presentation options (`{ size, centered }`), not content, so a progress render
// must go through `show`.
//
// This module is the isolated helper around that lifecycle. It is render-free on
// purpose: it owns *tokens and lifetime*, the surface owns *presentation*.
//
//   * `ProgressSurface` is the abstract `{ set(message), clear() }` contract the
//     controller depends on, so the whole lifecycle is testable without a TUI;
//     the single runtime binding lives at the composition root (`tui.tsx`),
//     which is the only module that knows the dialog.
//   * Every `show()` replaces the previous surface and hands back a token-checked
//     handle, so clearing an older handle can never dismiss a newer surface.
//   * `run()` scopes ownership: a denied/duplicate invocation never gets a run
//     and therefore can never clear the active run's progress, and a run's
//     `release()` only clears what that run still owns.
//   * Clearing is idempotent and every surface call is contained — a hostile or
//     absent dialog degrades to "no progress", never a failed run.
//   * No intervals, no listeners, no globals: the caller's `finally` is the only
//     owner, so a reload or a disposal cannot leave a timer or a listener behind.

import type { RetitleLogger } from "./logger"

/** What is in flight; also the redaction-safe log identity of a progress run. */
export type ProgressStage = "generating" | "applying"

export const PROGRESS_GENERATING = "Generating title…"
export const PROGRESS_APPLYING = "Applying title…"

/**
 * The public UI surface progress is drawn on. Bound once, in `tui.tsx`, to
 * `context.ui.dialog` (`show`/`clear`). Deliberately message-in/render-free so
 * that nothing below the composition root needs JSX.
 */
export interface ProgressSurface {
  set(message: string): void
  clear(): void
}

export interface ProgressHandle {
  /** Clears this handle's surface. Idempotent; a no-op once superseded. */
  clear(): void
}

/** A single granted run's progress lane. */
export interface ProgressRun {
  /** Shows `message`, replacing any earlier surface. Never throws. */
  show(message: string, stage: ProgressStage): ProgressHandle
  /** Clears this run's surface if it still owns it. Idempotent. */
  release(): void
}

export interface ProgressController {
  /**
   * Opens a progress lane for one granted run. A rejected invocation never
   * reaches this point, so it cannot touch another run's progress.
   */
  run(): ProgressRun
  /** True while a surface is up. Diagnostics and tests only. */
  readonly active: boolean
}

export function createProgressController(
  surface: ProgressSurface | undefined,
  logger?: RetitleLogger,
): ProgressController {
  type Entry = { readonly owner: symbol; readonly token: symbol; readonly stage: ProgressStage }
  let current: Entry | undefined

  /** Drops `entry` if it is still the current one; idempotent by construction. */
  const dismiss = (entry: Entry): void => {
    if (current?.token !== entry.token) return
    current = undefined
    contain(() => surface?.clear(), logger, "progress-clear-error")
    logger?.event("progress-cleared", { stage: entry.stage })
  }

  return {
    run(): ProgressRun {
      const owner = Symbol("retitle-progress-run")
      return {
        show(message, stage): ProgressHandle {
          const entry: Entry = { owner, token: Symbol("retitle-progress"), stage }
          current = entry
          contain(() => surface?.set(message), logger, "progress-show-error")
          logger?.event("progress-shown", { stage })
          return {
            clear() {
              dismiss(entry)
            },
          }
        },
        release() {
          if (current === undefined || current.owner !== owner) return
          dismiss(current)
        },
      }
    },
    get active() {
      return current !== undefined
    },
  }
}

/**
 * Runs `work` with `message` on screen and clears the surface on every exit
 * path: success, candidate cancel, deadline, generation error, apply error, or
 * an unexpected throw.
 */
export async function withProgress<T>(
  run: ProgressRun,
  message: string,
  stage: ProgressStage,
  work: () => Promise<T>,
): Promise<T> {
  const handle = run.show(message, stage)
  try {
    return await work()
  } finally {
    handle.clear()
  }
}

/** A progress surface must never be able to fail the run it reports on. */
function contain(action: () => void, logger: RetitleLogger | undefined, event: string): void {
  try {
    action()
  } catch (error) {
    logger?.event(event, { error })
  }
}
