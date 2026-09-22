// Lifecycle tests for the run-scoped progress controller: what is shown, what
// is cleared, and — the part that actually matters — what a stale handle, a
// denied run or a hostile dialog is *not* allowed to clear.

import { describe, expect, test } from "bun:test"
import {
  createProgressController,
  withProgress,
  PROGRESS_APPLYING,
  PROGRESS_GENERATING,
  type ProgressSurface,
} from "../progress"
import { fakeProgress } from "./fake"

function surfaceThatThrows(): { surface: ProgressSurface; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    surface: {
      set(message) {
        calls.push(`set:${message}`)
        throw new Error("dialog exploded")
      },
      clear() {
        calls.push("clear")
        throw new Error("dialog exploded")
      },
    },
  }
}

function captureLogger() {
  const events: Array<{ name: string; fields: Record<string, unknown> }> = []
  return {
    events,
    logger: {
      event: (name: string, fields: Record<string, unknown> = {}) => void events.push({ name, fields }),
    },
  }
}

describe("createProgressController", () => {
  test("shows a message and clears it exactly once", () => {
    const progress = fakeProgress()
    const run = createProgressController(progress.surface).run()

    const handle = run.show(PROGRESS_GENERATING, "generating")
    expect(progress.active()).toBe(PROGRESS_GENERATING)

    handle.clear()
    expect(progress.active()).toBeUndefined()
    expect(progress.events).toEqual([
      { kind: "set", message: PROGRESS_GENERATING },
      { kind: "clear" },
    ])

    // Idempotent: a second clear is a no-op, so a `finally` cannot double-clear
    // a surface that is no longer ours.
    handle.clear()
    expect(progress.events).toHaveLength(2)
  })

  test("an older handle cannot clear a newer surface", () => {
    const progress = fakeProgress()
    const run = createProgressController(progress.surface).run()

    const generating = run.show(PROGRESS_GENERATING, "generating")
    const applying = run.show(PROGRESS_APPLYING, "applying")

    generating.clear()

    expect(progress.active()).toBe(PROGRESS_APPLYING)
    expect(progress.events).toEqual([
      { kind: "set", message: PROGRESS_GENERATING },
      { kind: "set", message: PROGRESS_APPLYING },
    ])

    applying.clear()
    expect(progress.active()).toBeUndefined()
  })

  test("a run only clears the surface it still owns", () => {
    const progress = fakeProgress()
    const controller = createProgressController(progress.surface)
    const first = controller.run()
    const second = controller.run()

    first.show(PROGRESS_GENERATING, "generating")
    second.release()
    // The second run never showed anything: releasing it must not dismiss the
    // first run's surface.
    expect(progress.active()).toBe(PROGRESS_GENERATING)

    second.show(PROGRESS_APPLYING, "applying")
    first.release()
    // The first run no longer owns the surface.
    expect(progress.active()).toBe(PROGRESS_APPLYING)

    second.release()
    expect(progress.active()).toBeUndefined()
    // Releasing twice is a no-op.
    first.release()
    second.release()
    expect(progress.events).toEqual([
      { kind: "set", message: PROGRESS_GENERATING },
      { kind: "set", message: PROGRESS_APPLYING },
      { kind: "clear" },
    ])
  })

  test("tracks active state and survives a missing surface", () => {
    const controller = createProgressController(undefined)
    const run = controller.run()

    expect(controller.active).toBe(false)
    const handle = run.show(PROGRESS_GENERATING, "generating")
    expect(controller.active).toBe(true)
    handle.clear()
    expect(controller.active).toBe(false)
    // Nothing to clear, and still safe to release.
    run.release()
    expect(controller.active).toBe(false)
  })

  test("contains a hostile surface instead of failing the run", () => {
    const { surface, calls } = surfaceThatThrows()
    const log = captureLogger()
    const controller = createProgressController(surface, log.logger)
    const run = controller.run()

    const handle = run.show(PROGRESS_GENERATING, "generating")
    expect(calls).toEqual([`set:${PROGRESS_GENERATING}`])
    handle.clear()
    run.release()

    expect(log.events.filter((event) => event.name === "progress-show-error")).toHaveLength(1)
    expect(log.events.filter((event) => event.name === "progress-clear-error")).toHaveLength(1)
    expect(controller.active).toBe(false)
  })

  test("logs stage metadata only", () => {
    const progress = fakeProgress()
    const log = captureLogger()
    const run = createProgressController(progress.surface, log.logger).run()

    run.show(PROGRESS_APPLYING, "applying").clear()

    expect(log.events).toEqual([
      { name: "progress-shown", fields: { stage: "applying" } },
      { name: "progress-cleared", fields: { stage: "applying" } },
    ])
  })
})

describe("withProgress", () => {
  test("keeps the message up for the work and clears it afterwards", async () => {
    const progress = fakeProgress()
    const run = createProgressController(progress.surface).run()

    const result = await withProgress(run, PROGRESS_APPLYING, "applying", async () => {
      expect(progress.active()).toBe(PROGRESS_APPLYING)
      return "done"
    })

    expect(result).toBe("done")
    expect(progress.active()).toBeUndefined()
  })

  test("clears on a rejection and rethrows the original failure", async () => {
    const progress = fakeProgress()
    const run = createProgressController(progress.surface).run()

    await expect(
      withProgress(run, PROGRESS_GENERATING, "generating", async () => {
        throw new Error("generation failed")
      }),
    ).rejects.toThrow("generation failed")

    expect(progress.active()).toBeUndefined()
    expect(progress.events).toEqual([
      { kind: "set", message: PROGRESS_GENERATING },
      { kind: "clear" },
    ])
  })

  test("clears when the work throws synchronously", async () => {
    const progress = fakeProgress()
    const run = createProgressController(progress.surface).run()

    await expect(
      withProgress(run, PROGRESS_GENERATING, "generating", () => {
        throw new Error("sync boom")
      }),
    ).rejects.toThrow("sync boom")

    expect(progress.active()).toBeUndefined()
  })
})
