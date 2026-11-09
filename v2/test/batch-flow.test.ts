// Tests for batch auto retitle (/retitle-auto-sessions).
// Covers tab list snapshotting, concurrency limiting, gate reservation,
// root-session filtering, failure isolation, and quiet progress updates.

import { describe, expect, test } from "bun:test"
import { createRetitleAdapter } from "../adapter"
import {
  RETITLE_AUTO_SESSIONS_COMMAND_ID,
  RETITLE_AUTO_SESSIONS_SLASH_NAME,
  createRetitleAutoSessionsCommand,
  retitleKeymapLayer,
} from "../command"
import { openRetitle, openRetitleAuto } from "../dialogs"
import { openRetitleAutoSessions } from "../batch"
import { assistantMessage, fakeCatalog, fakeClient, fakeContext, fakeProgress, fakeUi, recordingLogger, userMessage } from "./fake"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function drainUntil(until: () => boolean, limit = 200): Promise<void> {
  for (let index = 0; index < limit && !until(); index++) await Promise.resolve()
}

interface SetupTab {
  readonly sessionID: string
  readonly title?: string
  readonly active?: boolean
  readonly busy?: boolean
  readonly attention?: boolean
  readonly unread?: "activity" | "error"
}

function setupBatch(options: {
  readonly ui?: ReturnType<typeof fakeUi>
  readonly tabs?: readonly SetupTab[]
  readonly tabsEnabled?: boolean
  readonly omitTabs?: boolean
  readonly client?: ReturnType<typeof fakeClient>
  readonly sessionRootMap?: Record<string, string>
  readonly now?: () => number
  readonly messagesBySession?: Record<string, any[]>
}) {
  const tabsEnabled = options.tabsEnabled ?? true
  let tabList: readonly SetupTab[] = options.tabs ?? []

  const client = options.client ?? fakeClient({
    list: (sessionID?: string) => {
      const messages = (sessionID && options.messagesBySession?.[sessionID]) ?? [userMessage(`hello from ${sessionID}`)]
      return { data: messages, cursor: {} }
    },
    generate: (req: any) => ({
      title: `Title for ${req.sessionID ?? "session"}`,
    }),
  })

  const context = fakeContext({
    client: client.client,
    catalog: fakeCatalog({ models: [{ id: "gpt-5", providerID: "openai" }] }),
    sessionModel: { id: "gpt-5", providerID: "openai" },
  }) as any

  // Attach root mapping if specified
  if (options.sessionRootMap) {
    context.data.session.root = (id: string) => options.sessionRootMap?.[id] ?? id
  }

  const progress = fakeProgress()
  const recorded = recordingLogger()
  const adapter = createRetitleAdapter(context, {
    logger: recorded.logger,
    progressSurface: progress.surface,
    ...(options.now ? { now: options.now } : {}),
  })

  const ui = options.ui ?? fakeUi({ sessionID: "ses_active" })
  if (!options.omitTabs) {
    ;(ui.ui as any).tabs = {
      enabled: () => tabsEnabled,
      list: () => tabList,
      open: () => true,
      focus: () => true,
      move: () => true,
      close: () => true,
    }
  }

  return {
    client,
    context,
    adapter,
    ui,
    progress,
    recorded,
    setTabs: (next: readonly SetupTab[]) => {
      tabList = next
    },
  }
}

describe("command registration (/retitle-auto-sessions)", () => {
  test("registers three commands in retitleKeymapLayer with expected metadata", () => {
    const layer = retitleKeymapLayer(
      () => {},
      () => {},
      () => {},
    )
    expect(layer.mode).toBe("global")
    expect(layer.commands).toHaveLength(3)

    const [cmd, auto, batch] = layer.commands
    expect(cmd.id).toBe("retitle.session.retitle")
    expect(auto.id).toBe("retitle.session.retitle_auto")
    expect(batch.id).toBe(RETITLE_AUTO_SESSIONS_COMMAND_ID)
    expect(RETITLE_AUTO_SESSIONS_COMMAND_ID).toBe("retitle.session.retitle_auto_sessions")
    expect(RETITLE_AUTO_SESSIONS_SLASH_NAME).toBe("retitle-auto-sessions")
    expect(batch.palette).toBe(true)
    expect(batch.slash).toEqual({ name: RETITLE_AUTO_SESSIONS_SLASH_NAME, arguments: true })
    expect("bind" in batch).toBe(false)
  })

  test("creates standalone batch command with error containment", async () => {
    const errors: unknown[] = []
    const cmd = createRetitleAutoSessionsCommand(
      async () => {
        throw new Error("batch failure")
      },
      (err) => errors.push(err),
    )
    expect(() => cmd.run("--samples 5")).not.toThrow()
    await drainUntil(() => errors.length === 1)
    expect(errors).toHaveLength(1)
  })
})

describe("batch execution lifecycle (/retitle-auto-sessions)", () => {
  test("snapshots 13 open tabs once and executes exactly 13 with bounded concurrency 2", async () => {
    const sessions = Array.from({ length: 13 }, (_, i) => `ses_tab_${i + 1}`)
    const tabs: SetupTab[] = sessions.map((id, i) => ({ sessionID: id, active: i === 0, busy: false, attention: false }))

    let activeGenerations = 0
    let maxObservedConcurrency = 0
    const defs = new Map<string, ReturnType<typeof deferred<void>>>()
    for (const id of sessions) {
      defs.set(id, deferred<void>())
    }

    const { adapter, ui, client, setTabs } = setupBatch({
      tabs,
      client: fakeClient({
        list: () => ({ data: [userMessage("turn")], cursor: {} }),
        generate: async (req: any) => {
          activeGenerations++
          maxObservedConcurrency = Math.max(maxObservedConcurrency, activeGenerations)
          const def = defs.get(req.sessionID)
          if (def) await def.promise
          activeGenerations--
          return { title: `Generated for ${req.sessionID}` }
        },
      }),
    })

    const progressUpdates: Array<string | undefined> = []
    const pendingDeltas: number[] = []

    const batchPromise = openRetitleAutoSessions(ui, adapter, "--samples 10", {
      onProgress: (p) => progressUpdates.push(p.text),
      onPendingChange: (d) => pendingDeltas.push(d),
    })

    // Mutate tabs immediately to prove snapshot immutability
    setTabs([{ sessionID: "ses_new_tab", active: true, busy: false, attention: false }])

    // Wait until concurrency hits 2
    await drainUntil(() => activeGenerations === 2)
    expect(maxObservedConcurrency).toBe(2)

    // Release all in order
    for (const id of sessions) {
      defs.get(id)?.resolve()
      await drainUntil(() => !defs.get(id))
    }

    const summary = await batchPromise
    expect(summary.total).toBe(13)
    expect(summary.updated).toBe(13)
    expect(summary.failed).toBe(0)
    expect(summary.skipped).toBe(0)
    expect(client.calls.generates).toHaveLength(13)
    expect(client.calls.renames).toHaveLength(13)
    expect(maxObservedConcurrency).toBeLessThanOrEqual(2)
  })

  test("deduplicates tab session IDs and filters out non-root/helper sessions", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_root_1", active: true, busy: false, attention: false },
      { sessionID: "ses_root_1", active: false, busy: false, attention: false }, // duplicate
      { sessionID: "ses_root_2", active: false, busy: false, attention: false },
      { sessionID: "ses_child_3", active: false, busy: false, attention: false }, // helper/child
    ]

    const { adapter, ui, client } = setupBatch({
      tabs,
      sessionRootMap: {
        ses_root_1: "ses_root_1",
        ses_root_2: "ses_root_2",
        ses_child_3: "ses_root_1", // non-root
      },
    })

    const summary = await openRetitleAutoSessions(ui, adapter, "")
    expect(summary.total).toBe(2)
    expect(summary.updated).toBe(2)
    expect(client.calls.generates).toHaveLength(2)
  })

  test("exits with clean nonblocking no-op when tabs are missing or disabled", async () => {
    const { adapter, ui, client } = setupBatch({
      omitTabs: true,
    })

    const summary = await openRetitleAutoSessions(ui, adapter, "")
    expect(summary.total).toBe(0)
    expect(summary.updated).toBe(0)
    expect(client.calls.generates).toHaveLength(0)
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0].message).toContain("Session tabs not available")
  })

  test("suppresses duplicate concurrent batch invocation immediately without resetting progress", async () => {
    const def = deferred<void>()
    const tabs: SetupTab[] = [{ sessionID: "ses_tab_1", active: true, busy: false, attention: false }]

    const { adapter, ui } = setupBatch({
      tabs,
      client: fakeClient({
        list: () => ({ data: [userMessage("hi")], cursor: {} }),
        generate: async () => {
          await def.promise
          return { title: "Title 1" }
        },
      }),
    })

    const firstRun = openRetitleAutoSessions(ui, adapter, "")
    await Promise.resolve()

    const secondRun = await openRetitleAutoSessions(ui, adapter, "")
    expect(secondRun.status).toBe("skipped")
    expect(secondRun.reason).toBe("already-running")

    def.resolve()
    const firstResult = await firstRun
    expect(firstResult.status).toBe("completed")
    expect(firstResult.updated).toBe(1)
  })

  test("synchronously pre-claims gate for all captured IDs protecting queued tabs from singleton auto", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_1", active: true, busy: false, attention: false },
      { sessionID: "ses_2", active: false, busy: false, attention: false },
      { sessionID: "ses_3", active: false, busy: false, attention: false },
    ]

    const def1 = deferred<void>()
    const { adapter, ui } = setupBatch({
      tabs,
      client: fakeClient({
        list: () => ({ data: [userMessage("hi")], cursor: {} }),
        generate: async (req: any) => {
          if (req.sessionID === "ses_1") await def1.promise
          return { title: `Title ${req.sessionID}` }
        },
      }),
    })

    const batchPromise = openRetitleAutoSessions(ui, adapter, "")
    // While batch is running ses_1 and queued ses_2, ses_3:
    expect(adapter.gate.running("ses_1")).toBe(true)
    expect(adapter.gate.running("ses_2")).toBe(true)
    expect(adapter.gate.running("ses_3")).toBe(true)

    // Attempting singleton auto on queued session ses_2 must be rejected by gate
    ui.setRoute({ type: "session", sessionID: "ses_2" })
    await openRetitleAuto(ui, adapter, "")
    expect(ui.toasts.some((t) => t.message === "Retitle already running")).toBe(true)

    def1.resolve()
    const res = await batchPromise
    expect(res.updated).toBe(3)
    expect(adapter.gate.running()).toBe(false)
  })

  test("handles partial failures, apply errors, and empty messages gracefully with accurate counts", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_ok", active: true, busy: false, attention: false },
      { sessionID: "ses_empty", active: false, busy: false, attention: false },
      { sessionID: "ses_gen_error", active: false, busy: false, attention: false },
      { sessionID: "ses_apply_error", active: false, busy: false, attention: false },
    ]

    const { adapter, ui, client } = setupBatch({
      tabs,
      messagesBySession: {
        ses_ok: [userMessage("normal session")],
        ses_empty: [], // empty session
        ses_gen_error: [userMessage("will fail gen")],
        ses_apply_error: [userMessage("will fail apply")],
      },
      client: fakeClient({
        list: (sessionID?: string) => {
          if (sessionID === "ses_empty") return { data: [], cursor: {} }
          return { data: [userMessage("turn")], cursor: {} }
        },
        generate: async (req: any) => {
          if (req.sessionID === "ses_gen_error") throw new Error("generation error")
          return { title: `Generated title ${req.sessionID}` }
        },
        rename: (sessionID: string, title: string) => {
          if (sessionID === "ses_apply_error") return Promise.reject(new Error("rename network error"))
          return Promise.resolve()
        },
      }),
    })

    const summary = await openRetitleAutoSessions(ui, adapter, "")
    expect(summary.total).toBe(4)
    expect(summary.updated).toBe(1)
    expect(summary.skipped).toBe(1) // empty is skipped
    expect(summary.failed).toBe(2) // gen error + apply error
    // Final single toast produced
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0].message).toContain("Batch retitle: 1 updated, 1 skipped, 2 failed")
    // Gate must be completely released
    expect(adapter.gate.running()).toBe(false)
  })

  test("cleans up all pre-claimed tokens in finally even if an observer or unexpected error throws", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_a", active: true, busy: false, attention: false },
      { sessionID: "ses_b", active: false, busy: false, attention: false },
    ]

    const { adapter, ui } = setupBatch({
      tabs,
    })

    await expect(
      openRetitleAutoSessions(ui, adapter, "", {
        onProgress: () => {
          throw new Error("fatal observer crash")
        },
      }),
    ).rejects.toThrow("fatal observer crash")

    expect(adapter.gate.running()).toBe(false)
    expect(adapter.gate.running("ses_a")).toBe(false)
    expect(adapter.gate.running("ses_b")).toBe(false)
  })
})
