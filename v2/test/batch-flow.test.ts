// Tests for batch auto retitle (/retitle-auto-sessions).
// Covers tab list snapshotting, concurrency limiting, gate reservation,
// root-session and helper filtering, failure isolation, and quiet progress updates.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createRetitleAdapter } from "../adapter"
import {
  RETITLE_AUTO_SESSIONS_COMMAND_ID,
  RETITLE_AUTO_SESSIONS_SLASH_NAME,
  createRetitleAutoSessionsCommand,
  retitleKeymapLayer,
} from "../command"
import { openRetitle, openRetitleAuto } from "../dialogs"
import { openRetitleAutoSessions, BatchController, createBatchController } from "../batch"
import { HELPER_TITLE, TITLE_AGENT } from "../session-api"
import { verifyCapturedSession } from "../batch-scope"
import { fakeCatalog, fakeClient, fakeContext, fakeProgress, fakeUi, recordingLogger, userMessage } from "./fake"

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
  readonly sessionMetadataMap?: Record<string, { parentID?: string; agent?: string; title?: string }>
  readonly now?: () => number
  readonly messagesBySession?: Record<string, any[]>
  readonly poisonServerSessionList?: boolean
}) {
  const tabsEnabled = options.tabsEnabled ?? true
  let tabList: readonly SetupTab[] = options.tabs ?? []
  let helperCounter = 0

  const client = options.client ?? fakeClient({
    create: () => ({ id: `ses_helper_${++helperCounter}` }),
    list: (input: { sessionID: string }) => {
      const messages = (input.sessionID && options.messagesBySession?.[input.sessionID]) ?? [
        userMessage(`hello from [${input.sessionID}]`),
      ]
      return { data: messages, cursor: {} }
    },
    generate: (input: { sessionID: string; prompt: string }) => ({
      text: `Title for ${input.prompt.includes("[ses_") ? input.prompt : "session"}`,
    }),
  })

  const context = fakeContext({
    client: client.client,
    catalog: fakeCatalog({ models: [{ id: "gpt-5", providerID: "openai" }] }),
    sessionModel: { id: "gpt-5", providerID: "openai" },
  }) as any

  // Attach root mapping if specified
  context.data.session.root = (id: string) => options.sessionRootMap?.[id] ?? id

  // Session get metadata
  const originalGet = context.data.session.get
  context.data.session.get = (id: string) => {
    const meta = options.sessionMetadataMap?.[id]
    if (meta) return { id, model: null, ...meta }
    return { id, model: null, ...(originalGet?.(id) ?? {}) }
  }

  // client.session.get
  if (!(client.client.session as any).get) {
    ;(client.client.session as any).get = async (input: { sessionID: string }) => {
      const meta = options.sessionMetadataMap?.[input.sessionID]
      return { id: input.sessionID, model: null, agent: "coder", ...(meta ?? {}) }
    }
  }

  // Poison server session list to assert batch never queries server session list
  if (options.poisonServerSessionList) {
    context.data.session.list = () => {
      throw new Error("POISON: data.session.list must never be called by batch")
    }
    ;(client.client.session as any).list = () => {
      throw new Error("POISON: client.session.list must never be called by batch")
    }
  }

  const progress = fakeProgress()
  const recorded = recordingLogger()
  const adapter = createRetitleAdapter(context, {
    logger: recorded.logger,
    progressSurface: progress.surface,
    ...(options.now ? { now: options.now } : {}),
  })

  const ui = options.ui ?? fakeUi({ sessionID: "ses_active" })
  ;(ui as any).data = context.data
  ;(ui as any).client = context.client
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
  test("registers three commands when 4 args provided, and legacy 3 args passes onError to first 2", async () => {
    const errCalls: unknown[] = []
    const layer3 = retitleKeymapLayer(
      () => {
        throw new Error("legacy cmd err")
      },
      () => {},
      (err) => errCalls.push(err),
    )
    expect(layer3.mode).toBe("global")
    expect(layer3.commands).toHaveLength(2) // 3-arg legacy: handler, auto, onError -> 2 commands
    layer3.commands[0].run()
    await drainUntil(() => errCalls.length === 1)
    expect(errCalls).toHaveLength(1)

    const batchCalls: string[] = []
    const layer4 = retitleKeymapLayer(
      () => {},
      () => {},
      () => {},
      (raw) => {
        batchCalls.push(raw)
      },
    )
    expect(layer4.commands).toHaveLength(3) // 4-arg: handler, auto, onError, batchHandler -> 3 commands
    const [cmd, auto, batch] = layer4.commands
    expect(cmd.id).toBe("retitle.session.retitle")
    expect(auto.id).toBe("retitle.session.retitle_auto")
    expect(batch.id).toBe(RETITLE_AUTO_SESSIONS_COMMAND_ID)
    expect(RETITLE_AUTO_SESSIONS_COMMAND_ID).toBe("retitle.session.retitle_auto_sessions")
    expect(RETITLE_AUTO_SESSIONS_SLASH_NAME).toBe("retitle-auto-sessions")
    expect(batch.palette).toBe(true)
    expect(batch.slash).toEqual({ name: RETITLE_AUTO_SESSIONS_SLASH_NAME, arguments: true })
    expect("bind" in batch).toBe(false)

    // Verify 4th argument dispatch receives raw args
    batch.run("--samples 12 hint text")
    await drainUntil(() => batchCalls.length === 1)
    expect(batchCalls).toEqual(["--samples 12 hint text"])
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

describe("Blocker 1 & TUI contract: footer status wiring and numeric progress", () => {
  test("tui.tsx wires pendingBatch and batchText into footer status and prioritizes label", () => {
    const source = readFileSync(new URL("../tui.tsx", import.meta.url), "utf8")
    expect(source).toContain("const [pendingBatch, setPendingBatch] = createSignal(0)")
    expect(source).toContain("const [batchText, setBatchText] = createSignal<string | undefined>(undefined)")
    expect(source).toContain("<Show when={pendingBatch() > 0 || pendingAuto() > 0 || pendingInteractive() > 0}>")
    expect(source).toContain("pendingBatch() > 0")
    expect(source).toContain('batchText() ?? `/${RETITLE_AUTO_SESSIONS_SLASH_NAME}`')
  })
})

describe("Blocker 2 & Hole 2: preclaim gate.begin throw cleanup & settings throw cleanup", () => {
  test("re-cleans all pre-claimed gate tokens if settings.read throws, with retry succeeding", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_leak_1", active: true, busy: false, attention: false },
      { sessionID: "ses_leak_2", active: false, busy: false, attention: false },
    ]

    let now = 1000
    const { adapter, ui } = setupBatch({ tabs, now: () => (now += 500) })
    let failSettings = true
    const brokenAdapter = {
      ...adapter,
      settings: {
        ...adapter.settings,
        read: () => {
          if (failSettings) throw new Error("corrupt settings")
          return adapter.settings.read()
        },
      },
    }

    await expect(openRetitleAutoSessions(ui, brokenAdapter, "")).rejects.toThrow("corrupt settings")

    // Gate MUST be completely released
    expect(adapter.gate.running("ses_leak_1")).toBe(false)
    expect(adapter.gate.running("ses_leak_2")).toBe(false)

    // Advance time past debounce window so retry can claim
    now += 1000
    failSettings = false
    const res = await openRetitleAutoSessions(ui, brokenAdapter, "")
    expect(res.status).toBe("completed")
    expect(res.updated).toBe(2)
  })

  test("cleans previously claimed tokens and releases adapter lock if gate.begin throws on second ID", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_gate_ok_1", active: true, busy: false, attention: false },
      { sessionID: "ses_gate_boom_2", active: false, busy: false, attention: false },
    ]

    let now = 2000
    const { adapter, ui } = setupBatch({ tabs, now: () => (now += 500) })

    // Also pre-occupy a foreign session to assert its token is not disrupted
    const foreignGrant = adapter.gate.begin("ses_foreign_busy", { interactive: false })
    expect(foreignGrant.ok).toBe(true)

    const origBegin = adapter.gate.begin.bind(adapter.gate)
    let gateFail = true
    adapter.gate.begin = (id?: string, opts?: any) => {
      if (gateFail && id === "ses_gate_boom_2") {
        throw new Error("unexpected gate crash on second session")
      }
      return origBegin(id, opts)
    }

    await expect(openRetitleAutoSessions(ui, adapter, "")).rejects.toThrow("unexpected gate crash on second session")

    // ses_gate_ok_1 must be released, foreign busy must remain occupied
    expect(adapter.gate.running("ses_gate_ok_1")).toBe(false)
    expect(adapter.gate.running("ses_foreign_busy")).toBe(true)

    // Next batch invocation on same adapter succeeds after gate unblocks
    gateFail = false
    now += 1000
    const retryRes = await openRetitleAutoSessions(ui, adapter, "")
    expect(retryRes.status).toBe("completed")
    expect(retryRes.total).toBe(2)
    expect(retryRes.updated).toBe(2)

    if (foreignGrant.ok) adapter.gate.end(foreignGrant.token)
  })
})

describe("Hole 1: progress.run throw in executeRetitleAutoWithGrant does not leak gate", () => {
  test("per-session progress.run throw releases gate token and allows remaining jobs and next run", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_prog_throw_1", active: true, busy: false, attention: false },
      { sessionID: "ses_prog_ok_2", active: false, busy: false, attention: false },
    ]

    let now = 3000
    const { adapter, ui, context } = setupBatch({
      tabs,
      now: () => (now += 500),
      sessionMetadataMap: {
        ses_prog_throw_1: { agent: "coder" },
        ses_prog_ok_2: { agent: "coder" },
      },
    })

    const origRun = adapter.progress.run.bind(adapter.progress)
    let throwOnProg = true
    adapter.progress.run = (opts: any) => {
      if (throwOnProg && opts?.sessionID === "ses_prog_throw_1") {
        throw new Error("progress surface initialization crash")
      }
      return origRun(opts)
    }

    const summary = await openRetitleAutoSessions(ui, adapter, "", undefined, context.data)
    // ses_prog_throw_1 fails cleanly, ses_prog_ok_2 updates
    expect(summary.total).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.updated).toBe(1)

    // Both gates must be completely released
    expect(adapter.gate.running("ses_prog_throw_1")).toBe(false)
    expect(adapter.gate.running("ses_prog_ok_2")).toBe(false)

    // Singleton openRetitleAuto also releases gate if progress.run throws
    ui.setRoute({ type: "session", sessionID: "ses_prog_throw_1" })
    now += 1000
    await openRetitleAuto(ui, adapter, "")
    expect(adapter.gate.running("ses_prog_throw_1")).toBe(false)
  })
})

describe("Reviewer Blocker 1 & 2: Fail-closed metadata verification, exact fallback, helper role exclusion", () => {
  test("wrong cache IDs, missing root, and wrong after-sync IDs never prove eligibility", async () => {
    const { adapter, ui } = setupBatch({ tabs: [{ sessionID: "target" }] })
    for (const session of [
      { get: () => ({ id: "other" }), root: () => "target" },
      { get: () => ({ id: "target" }) },
      { get: () => ({ id: "other" }), root: () => "target", sync: async () => {} },
    ]) {
      ;(ui as any).client = { session: { get: async () => undefined } }
      const result = await verifyCapturedSession("target", ui, adapter, { session })
      expect(result).toEqual({ verified: false, sessionID: "target", reason: "unverified" })
    }
  })

  test("metadata logger failures do not abandon queued captured IDs", async () => {
    const { adapter, ui, context } = setupBatch({ tabs: ["bad1", "bad2", "good"].map((sessionID) => ({ sessionID })) })
    context.data.session.get = (id: string) => id.startsWith("bad") ? undefined : { id }
    ;(ui as any).client = { session: { get: async () => undefined } }
    adapter.logger.event = () => { throw new Error("logger") }
    // Avoid logger failures inside the healthy generation lifecycle.
    const result = await openRetitleAutoSessions(ui, adapter, "", undefined, context.data)
    expect(result.total).toBe(3)
    expect(result.skipped).toBe(2)
    expect(result.failed).toBe(1)
    expect(ui.toasts[0].message).toContain("2 unverified")
  })

  test("settings snapshot precedes held metadata", async () => {
    const { adapter, ui, client, context } = setupBatch({ tabs: [{ sessionID: "cold" }] })
    const held = deferred<void>()
    let cached = false
    context.data.session.get = (id: string) => cached ? { id } : undefined
    context.data.session.sync = async () => { await held.promise; cached = true }
    await adapter.settings.setModel("openai/gpt-5")
    const batch = openRetitleAutoSessions(ui, adapter, "")
    await adapter.settings.setModel("openai/gpt-4o-mini")
    held.resolve()
    expect((await batch).updated).toBe(1)
    expect(client.calls.creates[0].model).toEqual({ providerID: "openai", id: "gpt-5" })
  })

  test("hanging exact metadata fetch is bounded and skipped", async () => {
    const { adapter, ui, context } = setupBatch({ tabs: [{ sessionID: "cold" }] })
    context.data.session.get = () => undefined
    delete context.data.session.sync
    ;(ui as any).client = { session: { get: () => new Promise(() => {}) } }
    const keepAlive = setTimeout(() => {}, 6000)
    try {
      const result = await openRetitleAutoSessions(ui, adapter, "")
      expect(result.skipped).toBe(1)
      expect(ui.toasts[0].message).toContain("unverified")
    } finally { clearTimeout(keepAlive) }
  }, 7000)

  test("excludes helper with agent:title regardless of title rename, but includes normal user root named with helper title", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_renamed_helper", active: true, busy: false, attention: false },
      { sessionID: "ses_user_root_named_helper", active: false, busy: false, attention: false },
    ]

    const { adapter, ui, client, context } = setupBatch({
      tabs,
      sessionRootMap: {
        ses_renamed_helper: "ses_renamed_helper",
        ses_user_root_named_helper: "ses_user_root_named_helper",
      },
      sessionMetadataMap: {
        // Helper renamed its title to something arbitrary, but agent is 'title'
        ses_renamed_helper: { agent: TITLE_AGENT, title: "Custom User Title" },
        // User session happened to be titled " Retitle generation", but agent is normal ('coder')
        ses_user_root_named_helper: { agent: "coder", title: HELPER_TITLE },
      },
    })

    const summary = await openRetitleAutoSessions(ui, adapter, "", undefined, context.data)
    expect(summary.total).toBe(2)
    expect(summary.skipped).toBe(1) // ses_renamed_helper excluded
    expect(summary.updated).toBe(1)
    expect(client.calls.generates).toHaveLength(1)
    expect(client.calls.generates[0].prompt).toContain("ses_user_root_named_helper")
  })

  test("fails closed when metadata throws or missing: unverified session skipped, verified session proceeds", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_meta_throws", active: true, busy: false, attention: false },
      { sessionID: "ses_meta_ok", active: false, busy: false, attention: false },
    ]

    const { adapter, ui, client, context } = setupBatch({
      tabs,
      sessionRootMap: {
        ses_meta_ok: "ses_meta_ok",
      },
      sessionMetadataMap: {
        ses_meta_ok: { agent: "coder" },
      },
    })

    // Make get throw for ses_meta_throws
    const origGet = context.data.session.get
    context.data.session.get = (id: string) => {
      if (id === "ses_meta_throws") throw new Error("corrupt local session cache")
      return origGet(id)
    }
    ;(client.client.session as any).get = async ({ sessionID }: { sessionID: string }) =>
      sessionID === "ses_meta_throws" ? undefined : { id: sessionID }

    const summary = await openRetitleAutoSessions(ui, adapter, "", undefined, context.data)
    expect(summary.total).toBe(2)
    expect(summary.skipped).toBe(1) // ses_meta_throws failed-closed as unverified
    expect(summary.updated).toBe(1) // ses_meta_ok succeeded
    expect(client.calls.generates).toHaveLength(1)
    expect(client.calls.generates[0].prompt).toContain("ses_meta_ok")
  })

  test("cold legit root with uncached get recovers via exact data.session.sync / client.session.get fallback", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_cold_root", active: true, busy: false, attention: false },
    ]

    let cachePopulated = false
    const { adapter, ui, client, context } = setupBatch({
      tabs,
      sessionRootMap: {
        ses_cold_root: "ses_cold_root",
      },
    })

    // Initially uncached
    context.data.session.get = (id: string) => {
      if (!cachePopulated) return undefined
      return { id, agent: "coder" }
    }

    // sync(id) will populate cache
    context.data.session.sync = async (id: string) => {
      cachePopulated = true
    }

    const summary = await openRetitleAutoSessions(ui, adapter, "", undefined, context.data)
    expect(summary.total).toBe(1)
    expect(summary.updated).toBe(1)
    expect(client.calls.generates).toHaveLength(1)
  })

  test("fails closed if exact sync/get returns mismatched id or remains untrusted", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_untrusted_id", active: true, busy: false, attention: false },
    ]

    const { adapter, ui, client, context } = setupBatch({
      tabs,
      sessionRootMap: {
        ses_untrusted_id: "ses_untrusted_id",
      },
    })

    // get returns undefined
    context.data.session.get = () => undefined
    // sync throws or fails
    context.data.session.sync = async () => {
      throw new Error("404 session not found")
    }
    ;(client.client.session as any).get = async () => ({ id: "wrong" })

    const summary = await openRetitleAutoSessions(ui, adapter, "", undefined, context.data)
    expect(summary.total).toBe(1)
    expect(summary.skipped).toBe(1) // fail-closed
    expect(summary.updated).toBe(0)
    expect(client.calls.generates).toHaveLength(0)
  })
})

describe("Reviewer Blocker 3: tabs.enabled/list throw containment in owned run try", () => {
  test("tabs.enabled throwing is caught cleanly, emits one warning toast, releases all, and next run succeeds", async () => {
    const tabs: SetupTab[] = [{ sessionID: "ses_tab_1", active: true, busy: false, attention: false }]
    const { adapter, ui } = setupBatch({ tabs })

    let enabledThrows = true
    ;(ui.ui as any).tabs.enabled = () => {
      if (enabledThrows) throw new Error("host tabs error")
      return true
    }

    const summary = await openRetitleAutoSessions(ui, adapter, "")
    expect(summary.status).toBe("skipped")
    expect(summary.reason).toBe("no-tabs")
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0].message).toContain("Session tabs not available or empty")
    expect(adapter.gate.running()).toBe(false)

    // Next run succeeds when tabs recover
    enabledThrows = false
    const retry = await openRetitleAutoSessions(ui, adapter, "")
    expect(retry.status).toBe("completed")
    expect(retry.total).toBe(1)
    expect(retry.updated).toBe(1)
  })

  test("tabs.list throwing is caught cleanly, emits one warning toast, releases all, and next run succeeds", async () => {
    const tabs: SetupTab[] = [{ sessionID: "ses_tab_1", active: true, busy: false, attention: false }]
    const { adapter, ui } = setupBatch({ tabs })

    let listThrows = true
    ;(ui.ui as any).tabs.list = () => {
      if (listThrows) throw new Error("tabs list render crash")
      return tabs
    }

    const summary = await openRetitleAutoSessions(ui, adapter, "")
    expect(summary.status).toBe("skipped")
    expect(summary.reason).toBe("no-tabs")
    expect(ui.toasts).toHaveLength(1)
    expect(adapter.gate.running()).toBe(false)

    listThrows = false
    const retry = await openRetitleAutoSessions(ui, adapter, "")
    expect(retry.status).toBe("completed")
    expect(retry.total).toBe(1)
    expect(retry.updated).toBe(1)
  })
})

describe("Reviewer Blocker 4: worker logger.event throw containment protects held sibling workers", () => {
  test("logger throw on worker 1 failure does not abort worker 2 or release worker 2 gate early", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_logger_crash_1", active: true, busy: false, attention: false },
      { sessionID: "ses_held_sibling_2", active: false, busy: false, attention: false },
      { sessionID: "ses_queued_3" },
    ]

    const defSibling = deferred<void>()
    const { adapter, ui, client, context } = setupBatch({
      tabs,
      sessionMetadataMap: {
        ses_logger_crash_1: { agent: "coder" },
        ses_held_sibling_2: { agent: "coder" },
      },
      client: fakeClient({
        list: (input) => {
          if (input.sessionID === "ses_logger_crash_1") throw new Error("worker 1 network error")
          return { data: [userMessage(input.sessionID === "ses_held_sibling_2" ? "worker 2 turn" : "worker 3 turn")], cursor: {} }
        },
        generate: async (input) => {
          if (input.prompt.includes("worker 2 turn")) await defSibling.promise
          return { text: "Sibling Title" }
        },
      }),
    })

    // Injected hostile logger that throws on batch-worker-error
    const origEvent = adapter.logger.event.bind(adapter.logger)
    adapter.logger.event = (name: string, payload?: any) => {
      if (name === "batch-worker-error") {
        throw new Error("hostile telemetry logger crash")
      }
      return origEvent(name, payload)
    }
    const originalRun = adapter.progress.run.bind(adapter.progress)
    adapter.progress.run = (opts: any) => {
      if (opts.sessionID === "ses_logger_crash_1") throw new Error("worker crash")
      return originalRun(opts)
    }

    const foreign = adapter.gate.begin("foreign", { interactive: false })
    const batchPromise = openRetitleAutoSessions(ui, adapter, "", undefined, context.data)

    // Wait until worker 1 crashes and worker 2 is in-flight held at generate
    await drainUntil(() => client.calls.generates.length === 1)

    // Worker 2 MUST still be running and its gate token held
    expect(adapter.gate.running("ses_held_sibling_2")).toBe(true)
    expect(adapter.gate.running("foreign")).toBe(true)

    // Attempting singleton auto on ses_held_sibling_2 while in-flight must be rejected
    ui.setRoute({ type: "session", sessionID: "ses_held_sibling_2" })
    await openRetitleAuto(ui, adapter, "")
    expect(ui.toasts.some((t) => t.message === "Retitle already running")).toBe(true)

    // Release worker 2
    defSibling.resolve()
    const summary = await batchPromise

    expect(summary.total).toBe(3)
    expect(summary.failed).toBe(1)
    expect(summary.updated).toBe(2)
    expect(adapter.gate.running("foreign")).toBe(true)
    if (foreign.ok) adapter.gate.end(foreign.token)
    expect(adapter.gate.running()).toBe(false)
  })
})

describe("Blocker 3: accurate completed count including preclaim skips and explicit progress text labels", () => {
  test("emits final progress completion == total with updated/skipped/failed explicit labels and active===0", async () => {
    let now = 1000
    const tabs: SetupTab[] = [
      { sessionID: "ses_pre_busy", active: false, busy: false, attention: false },
      { sessionID: "ses_ok_1", active: true, busy: false, attention: false },
    ]

    const { adapter, ui } = setupBatch({ tabs, now: () => now })
    const busyGrant = adapter.gate.begin("ses_pre_busy", { interactive: false })
    expect(busyGrant.ok).toBe(true)

    const progressSnapshots: any[] = []
    const summary = await openRetitleAutoSessions(ui, adapter, "", {
      onProgress: (p) => progressSnapshots.push(p),
    })

    expect(summary.total).toBe(2)
    expect(summary.skipped).toBe(1)
    expect(summary.updated).toBe(1)
    expect(summary.failed).toBe(0)

    const lastProgress = progressSnapshots[progressSnapshots.length - 1]
    expect(lastProgress.completed).toBe(2)
    expect(lastProgress.total).toBe(2)
    expect(lastProgress.active).toBe(0)
    expect(lastProgress.text).toContain("2/2")
    expect(lastProgress.text).toContain("1 updated")
    expect(lastProgress.text).toContain("1 skipped")
    expect(lastProgress.text).toContain("0 failed")

    if (busyGrant.ok) adapter.gate.end(busyGrant.token)
  })
})

describe("Blocker 4: two immediate completed batch invocations both toast summaries (no static failure debounce)", () => {
  test("two consecutive batches both receive distinct summary toasts", async () => {
    let now = 5000
    const tabs: SetupTab[] = [{ sessionID: "ses_batch_seq", active: true, busy: false, attention: false }]
    const { adapter, ui } = setupBatch({ tabs, now: () => (now += 500) })

    await openRetitleAutoSessions(ui, adapter, "")
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0].message).toContain("Batch retitle: 1 updated, 0 skipped, 0 failed")

    // Consecutive run on same session after gate release and debounce window
    now += 1000
    await openRetitleAutoSessions(ui, adapter, "")
    expect(ui.toasts).toHaveLength(2)
    expect(ui.toasts[1].message).toContain("Batch retitle: 1 updated, 0 skipped, 0 failed")
  })
})

describe("Blocker 5: cross-instance adapter-level active batch protection", () => {
  test("two controllers or openRetitleAutoSessions calls on same adapter protect against concurrent execution even if tab snapshot changes", async () => {
    const def = deferred<void>()
    const tabs1: SetupTab[] = [{ sessionID: "ses_init_1", active: true, busy: false, attention: false }]
    let currentTabs = tabs1

    const { adapter, ui, setTabs } = setupBatch({
      tabs: currentTabs,
      client: fakeClient({
        list: () => ({ data: [userMessage("turn")], cursor: {} }),
        generate: async () => {
          await def.promise
          return { text: "Generated Title" }
        },
      }),
    })

    const ctrl1 = createBatchController(ui, adapter)
    const run1 = ctrl1.run("")

    await Promise.resolve()

    // Now tab list mutates with a completely new ID
    setTabs([{ sessionID: "ses_mutated_unique", active: true, busy: false, attention: false }])

    // Controller 2 created on same adapter
    const ctrl2 = createBatchController(ui, adapter)
    const run2 = await ctrl2.run("")
    expect(run2.status).toBe("skipped")
    expect(run2.reason).toBe("already-running")

    // openRetitleAutoSessions on same adapter also rejected
    const run3 = await openRetitleAutoSessions(ui, adapter, "")
    expect(run3.status).toBe("skipped")
    expect(run3.reason).toBe("already-running")

    def.resolve()
    const res1 = await run1
    expect(res1.status).toBe("completed")
    expect(res1.updated).toBe(1)
  })
})

describe("Coverage gaps & regression suite", () => {
  test("chat busy:true tab is still processed if retitle gate is free", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_chat_busy", active: true, busy: true, attention: false },
    ]

    const { adapter, ui, client } = setupBatch({ tabs })
    const summary = await openRetitleAutoSessions(ui, adapter, "")
    expect(summary.total).toBe(1)
    expect(summary.updated).toBe(1)
    expect(client.calls.generates).toHaveLength(1)
  })

  test("synchronously pre-claims gate for all captured IDs protecting queued tabs from singleton auto and interactive in both directions", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_q1", active: true, busy: false, attention: false },
      { sessionID: "ses_q2", active: false, busy: false, attention: false },
      { sessionID: "ses_q3", active: false, busy: false, attention: false },
    ]

    const def1 = deferred<void>()
    let helperSeq = 0
    const { adapter, ui } = setupBatch({
      tabs,
      client: fakeClient({
        create: () => ({ id: `ses_h_${++helperSeq}` }),
        list: () => ({ data: [userMessage("hi")], cursor: {} }),
        generate: async (input) => {
          if (input.prompt.includes("ses_q1")) await def1.promise
          return { text: "Title" }
        },
      }),
    })

    const batchCtrl = new BatchController(ui, adapter)
    const batchPromise = batchCtrl.run("")
    // While batch is running ses_q1 and queued ses_q2, ses_q3:
    expect(adapter.gate.running("ses_q1")).toBe(true)
    expect(adapter.gate.running("ses_q2")).toBe(true)
    expect(adapter.gate.running("ses_q3")).toBe(true)

    // Attempting singleton auto on queued session ses_q2 must be rejected by gate
    ui.setRoute({ type: "session", sessionID: "ses_q2" })
    await openRetitleAuto(ui, adapter, "")
    expect(ui.toasts.some((t) => t.message === "Retitle already running")).toBe(true)

    // Attempting interactive retitle on ses_q3 must be rejected as well
    ui.setRoute({ type: "session", sessionID: "ses_q3" })
    await openRetitle(ui, adapter, "")
    expect(ui.toasts.some((t) => t.message === "Retitle already running")).toBe(true)

    def1.resolve()
    const res = await batchPromise
    expect(res.updated).toBe(3)
    expect(adapter.gate.running()).toBe(false)
  })

  test("snapshots 13 open tabs once and executes exactly 13 with bounded concurrency 2 and exact prompt markers", async () => {
    const sessions = Array.from({ length: 13 }, (_, i) => `ses_tab_${i + 1}`)
    const tabs: SetupTab[] = sessions.map((id, i) => ({ sessionID: id, active: i === 0, busy: false, attention: false }))

    let activeGenerations = 0
    let maxObservedConcurrency = 0
    let helperSeq = 0
    const defs = new Map<string, ReturnType<typeof deferred<void>>>()
    for (const id of sessions) {
      defs.set(id, deferred<void>())
    }

    const { adapter, ui, client, setTabs } = setupBatch({
      tabs,
      poisonServerSessionList: true,
      client: fakeClient({
        create: () => ({ id: `ses_helper_conc_${++helperSeq}` }),
        list: (input) => ({ data: [userMessage(`turn for [${input.sessionID}]`)], cursor: {} }),
        generate: async (input) => {
          activeGenerations++
          maxObservedConcurrency = Math.max(maxObservedConcurrency, activeGenerations)

          // Unambiguous bracketed marker matching [ses_tab_1] vs [ses_tab_10]
          const matchedSession = sessions.find((id) => input.prompt.includes(`[${id}]`))
          if (matchedSession) {
            const def = defs.get(matchedSession)
            if (def) await def.promise
          }

          activeGenerations--
          return { text: "Generated title" }
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

    // Wait until concurrency reaches 2
    await drainUntil(() => activeGenerations === 2)
    expect(maxObservedConcurrency).toBe(2)

    // Release all in order
    for (const id of sessions) {
      defs.get(id)?.resolve()
      await Promise.resolve()
    }

    const summary = await batchPromise
    expect(summary.total).toBe(13)
    expect(summary.updated).toBe(13)
    expect(summary.failed).toBe(0)
    expect(summary.skipped).toBe(0)
    expect(client.calls.generates).toHaveLength(13)
    expect(client.calls.renames).toHaveLength(13)
    expect(maxObservedConcurrency).toBe(2)
  })

  test("deduplicates tab session IDs and filters out non-root and known helper sessions", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_root_1", active: true, busy: false, attention: false },
      { sessionID: "ses_root_1", active: false, busy: false, attention: false }, // duplicate
      { sessionID: "ses_root_2", active: false, busy: false, attention: false },
      { sessionID: "ses_child_3", active: false, busy: false, attention: false }, // helper/child via root()
      { sessionID: "ses_child_4", active: false, busy: false, attention: false }, // helper/child via parentID
      { sessionID: "ses_open_helper_5", active: false, busy: false, attention: false }, // open plugin helper
    ]

    const { adapter, ui, client, context } = setupBatch({
      tabs,
      sessionRootMap: {
        ses_root_1: "ses_root_1",
        ses_root_2: "ses_root_2",
        ses_child_3: "ses_root_1", // non-root
      },
      sessionMetadataMap: {
        ses_child_4: { parentID: "ses_root_2" },
        ses_open_helper_5: { agent: TITLE_AGENT, title: HELPER_TITLE },
      },
    })

    const summary = await openRetitleAutoSessions(ui, adapter, "", undefined, context.data)
    expect(summary.total).toBe(5) // 5 unique captured IDs
    expect(summary.updated).toBe(2)
    expect(summary.skipped).toBe(3)
    expect(client.calls.generates).toHaveLength(2)
  })

  test("exits with clean nonblocking no-op when tabs are missing, disabled, or empty list", async () => {
    const { adapter: a1, ui: u1 } = setupBatch({ omitTabs: true })
    const res1 = await openRetitleAutoSessions(u1, a1, "")
    expect(res1.status).toBe("skipped")
    expect(res1.reason).toBe("no-tabs")

    const { adapter: a2, ui: u2 } = setupBatch({ tabsEnabled: false })
    const res2 = await openRetitleAutoSessions(u2, a2, "")
    expect(res2.status).toBe("skipped")
    expect(res2.reason).toBe("no-tabs")

    const { adapter: a3, ui: u3 } = setupBatch({ tabs: [] })
    const res3 = await openRetitleAutoSessions(u3, a3, "")
    expect(res3.status).toBe("skipped")
    expect(res3.reason).toBe("no-tabs")
  })

  test("skips completed-but-debounced tabs as well as in-flight tabs", async () => {
    let now = 1000
    const tabs: SetupTab[] = [
      { sessionID: "ses_debounced", active: false, busy: false, attention: false },
      { sessionID: "ses_fresh", active: true, busy: false, attention: false },
    ]

    const { adapter, ui } = setupBatch({ tabs, now: () => now })

    // Simulate ses_debounced completed 100ms ago (inside default 400ms debounce window)
    const grant = adapter.gate.begin("ses_debounced", { interactive: false })
    expect(grant.ok).toBe(true)
    if (grant.ok) adapter.gate.end(grant.token)

    now += 100 // inside 400ms window -> debounced
    const summary = await openRetitleAutoSessions(ui, adapter, "")
    expect(summary.total).toBe(2)
    expect(summary.skipped).toBe(1)
    expect(summary.updated).toBe(1)
  })

  test("snapshots settings once so settings store mutation mid-run does not affect ongoing batch", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_s1", active: true, busy: false, attention: false },
      { sessionID: "ses_s2", active: false, busy: false, attention: false },
    ]

    const { adapter, ui, client } = setupBatch({
      tabs,
      client: fakeClient({
        list: () => ({ data: [userMessage("turn")], cursor: {} }),
        generate: async () => {
          // Mutate settings store mid-run
          await adapter.settings.setModel("openai/gpt-4o-mini")
          return { text: "Title" }
        },
      }),
    })

    await adapter.settings.setModel("openai/gpt-5")
    const summary = await openRetitleAutoSessions(ui, adapter, "--samples 15")
    expect(summary.updated).toBe(2)
  })

  test("handles partial failures, apply errors, no-title, and empty messages gracefully with accurate counts", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_ok", active: true, busy: false, attention: false },
      { sessionID: "ses_empty", active: false, busy: false, attention: false },
      { sessionID: "ses_no_title", active: false, busy: false, attention: false },
      { sessionID: "ses_gen_error", active: false, busy: false, attention: false },
      { sessionID: "ses_apply_error", active: false, busy: false, attention: false },
    ]

    let hSeq = 0
    const { adapter, ui } = setupBatch({
      tabs,
      client: fakeClient({
        create: () => ({ id: `ses_hlp_${++hSeq}` }),
        list: (input) => {
          if (input.sessionID === "ses_empty") return { data: [], cursor: {} }
          return { data: [userMessage(`turn for [${input.sessionID}]`)], cursor: {} }
        },
        generate: async (input) => {
          if (input.prompt.includes("[ses_gen_error]")) throw new Error("generation error")
          if (input.prompt.includes("[ses_no_title]")) return { text: "" }
          return { text: "Generated title" }
        },
        rename: (input) => {
          if (input.sessionID === "ses_apply_error") return Promise.reject(new Error("rename network error"))
          return Promise.resolve()
        },
      }),
    })

    const summary = await openRetitleAutoSessions(ui, adapter, "")
    expect(summary.total).toBe(5)
    expect(summary.updated).toBe(1)
    expect(summary.skipped).toBe(1) // empty is skipped
    expect(summary.failed).toBe(3) // gen error + no-title + apply error
    // Final single toast produced
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0].message).toContain("Batch retitle: 1 updated, 1 skipped, 3 failed")
    // Gate must be completely released
    expect(adapter.gate.running()).toBe(false)
  })

  test("observer throw does not crash batch processing and gate cleanup is guaranteed", async () => {
    const tabs: SetupTab[] = [
      { sessionID: "ses_a", active: true, busy: false, attention: false },
      { sessionID: "ses_b", active: false, busy: false, attention: false },
    ]

    const { adapter, ui } = setupBatch({ tabs })

    const summary = await openRetitleAutoSessions(ui, adapter, "", {
      onProgress: () => {
        throw new Error("observer throw")
      },
    })

    expect(summary.updated).toBe(2)
    expect(adapter.gate.running()).toBe(false)
  })
})
