// Shared fakes for the behavioural tests.
//
// These stand in for the public client, the host's reactive data, the durable
// storage and the dialog surface, so the adapter, the runner and the dialog
// lifecycle can be driven end to end without a TUI.

import type { SessionApiClient } from "../session-api"
import { SETTINGS_KEY, type SettingsStorage } from "../settings"
import type { RetitleContext } from "../adapter"
import type { ProgressSurface } from "../progress"
import type { DialogApi, RetitleUiContext, SelectOption, ToastApi, ToastVariant } from "../dialogs"

export type Recorded = {
  readonly creates: Array<Record<string, unknown>>
  readonly generates: Array<{ sessionID: string; prompt: string }>
  readonly removes: Array<string>
  readonly renames: Array<{ sessionID: string; title: string }>
  readonly updates: Array<{ sessionID: string; title: string }>
  readonly renameOptions: Array<{ readonly signal?: AbortSignal } | undefined>
  readonly updateOptions: Array<{ readonly signal?: AbortSignal } | undefined>
  readonly lists: Array<{ sessionID: string; limit?: number; order?: "asc" | "desc" }>
}

export type FakeClientOptions = {
  readonly create?: (input: Record<string, unknown>) => Promise<unknown> | unknown
  readonly generate?: (input: { sessionID: string; prompt: string }) => Promise<unknown> | unknown
  readonly remove?: (input: { sessionID: string }) => Promise<unknown> | unknown
  readonly rename?: (input: { sessionID: string; title: string }) => Promise<unknown> | unknown
  readonly update?: (input: { sessionID: string; title: string }) => Promise<unknown> | unknown
  readonly list?: (input: { sessionID: string; limit?: number; order?: "asc" | "desc" }) => Promise<unknown> | unknown
  /** Omit `session.generate` entirely to simulate a runtime without it. */
  readonly withoutGenerate?: boolean
  /** Omit `session.rename`: the live runtime's shape, where only `update` exists. */
  readonly withoutRename?: boolean
  /** Omit `session.update` to simulate the pinned source's shape. */
  readonly withoutUpdate?: boolean
}

export function fakeClient(options: FakeClientOptions = {}) {
  const calls: Recorded = {
    creates: [],
    generates: [],
    removes: [],
    renames: [],
    updates: [],
    renameOptions: [],
    updateOptions: [],
    lists: [],
  }
  const client = {
    session: {
      create: (input: Record<string, unknown>) => {
        calls.creates.push(input)
        return Promise.resolve(options.create ? options.create(input) : { id: "ses_helper" })
      },
      remove: (input: { sessionID: string }) => {
        calls.removes.push(input.sessionID)
        return Promise.resolve(options.remove ? options.remove(input) : undefined)
      },
      ...(options.withoutRename
        ? {}
        : {
            rename: (input: { sessionID: string; title: string }, request?: { readonly signal?: AbortSignal }) => {
              calls.renames.push(input)
              calls.renameOptions.push(request)
              return Promise.resolve(options.rename ? options.rename(input) : undefined)
            },
          }),
      ...(options.withoutUpdate
        ? {}
        : {
            update: (input: { sessionID: string; title: string }, request?: { readonly signal?: AbortSignal }) => {
              calls.updates.push(input)
              calls.updateOptions.push(request)
              return Promise.resolve(options.update ? options.update(input) : undefined)
            },
          }),
      ...(options.withoutGenerate
        ? {}
        : {
            generate: (input: { sessionID: string; prompt: string }) => {
              calls.generates.push(input)
              return Promise.resolve(options.generate ? options.generate(input) : { text: "Generated title" })
            },
          }),
    },
    message: {
      list: (input: { sessionID: string; limit?: number; order?: "asc" | "desc" }) => {
        calls.lists.push(input)
        return Promise.resolve(options.list ? options.list(input) : { data: [], cursor: {} })
      },
    },
  } as unknown as SessionApiClient
  return { client, calls }
}

export function fakeStorage(initial: Record<string, unknown> = {}) {
  const writes: Array<Record<string, unknown>> = []
  const settingsState: Record<string, unknown> = { ...initial }
  const stores = new Map<string, Record<string, unknown>>()
  stores.set(SETTINGS_KEY, settingsState)

  const storage: SettingsStorage = {
    store<Value extends object>(key: string, options: { readonly initial: Value }) {
      let state = stores.get(key)
      if (!state) {
        state = {}
        stores.set(key, state)
      }
      for (const [k, value] of Object.entries(options.initial)) {
        if (!(k in state)) state[k] = value
      }
      const store = state as Value
      const update = (mutation: (draft: Value) => void) => {
        const draft = { ...(state as Value) }
        mutation(draft)
        Object.assign(state, draft)
        if (key === SETTINGS_KEY) {
          writes.push({ ...(draft as Record<string, unknown>) })
        }
        return Promise.resolve()
      }
      return [store, update] as const
    },
  }
  return { storage, writes, state: settingsState }
}

export type CatalogOptions = {
  readonly models?: Array<{ id: string; providerID: string; name?: string; status?: string; enabled?: boolean }>
  readonly providers?: Array<{ id: string; name?: string }>
  readonly agents?: Array<{ id: string; model?: { id?: string; providerID?: string; variant?: string } | null }>
}

export function fakeCatalog(options: CatalogOptions = {}) {
  const synced: string[] = []
  return {
    synced,
    model: {
      list: () => options.models ?? [],
      sync: () => {
        synced.push("model")
        return Promise.resolve()
      },
    },
    provider: {
      list: () => options.providers ?? [],
      sync: () => {
        synced.push("provider")
        return Promise.resolve()
      },
    },
    agent: {
      list: () => options.agents ?? [],
      sync: () => {
        synced.push("agent")
        return Promise.resolve()
      },
    },
  }
}

export type FakeCatalog = ReturnType<typeof fakeCatalog>

export type FakeContextInput = {
  readonly client: SessionApiClient
  readonly location?: { directory: string; workspaceID?: string }
  readonly catalog?: FakeCatalog
  readonly storage?: SettingsStorage
  readonly messages?: Array<unknown>
  readonly sessionModel?: { id?: string; providerID?: string; variant?: string } | null
  /**
   * Shape of the reactive session refresh: `ok` (default), `reject` (the sync
   * promise fails), `unsupported` (the runtime publishes neither method).
   */
  readonly refresh?: "ok" | "reject" | "unsupported"
  /** Makes `data.session.invalidate` throw, to test refresh containment. */
  readonly invalidateThrows?: boolean
}

export type FakeRetitleContext = RetitleContext & {
  /** `data.session.message.sync` calls (history fallback). */
  readonly syncs: string[]
  /** `data.session.sync` calls (post-write reactive refresh). */
  readonly refreshes: string[]
  /** `data.session.invalidate` calls (post-write reactive refresh). */
  readonly invalidations: string[]
}

export function fakeContext(input: FakeContextInput): FakeRetitleContext {
  const catalog = input.catalog ?? fakeCatalog()
  const syncs: string[] = []
  const refreshes: string[] = []
  const invalidations: string[] = []
  const messages = input.messages ?? []
  const refresh = input.refresh ?? "ok"
  const location = Object.assign(catalog, {
    default: () => ({ directory: input.location?.directory ?? "/workspace/default" }),
  })
  const refreshMethods =
    refresh === "unsupported"
      ? {}
      : {
          sync: (sessionID: string) => {
            refreshes.push(sessionID)
            return refresh === "reject" ? Promise.reject(new Error("refresh failed")) : Promise.resolve()
          },
          invalidate: (sessionID: string) => {
            invalidations.push(sessionID)
            if (input.invalidateThrows) throw new Error("invalidate failed")
          },
        }
  return {
    client: input.client,
    location: input.location,
    data: {
      location,
      session: {
        ...refreshMethods,
        get: () => ({ model: input.sessionModel ?? null }),
        message: {
          list: () => messages,
          sync: (sessionID: string) => {
            syncs.push(sessionID)
            return Promise.resolve()
          },
        },
      },
    },
    storage: input.storage ?? fakeStorage().storage,
    syncs,
    refreshes,
    invalidations,
  } as unknown as FakeRetitleContext
}

/** A `ProgressSurface` that records the messages it is asked to show and clear. */
export type FakeProgress = {
  readonly surface: ProgressSurface
  readonly events: Array<{ readonly kind: "set" | "clear"; readonly message?: string }>
  /** The message currently on screen, or undefined when nothing is shown. */
  readonly active: () => string | undefined
}

export function fakeProgress(): FakeProgress {
  const events: FakeProgress["events"] = []
  let visible: string | undefined
  return {
    surface: {
      set(message) {
        events.push({ kind: "set", message })
        visible = message
      },
      clear() {
        events.push({ kind: "clear" })
        visible = undefined
      },
    },
    events,
    active: () => visible,
  }
}

/** A logger that records events, so diagnostics can be asserted as metadata. */
export function recordingLogger() {
  const events: Array<{ name: string; fields: Record<string, unknown> }> = []
  return {
    events,
    logger: {
      event: (name: string, fields: Record<string, unknown> = {}) => {
        events.push({ name, fields })
      },
    },
    text: () => JSON.stringify(events),
  }
}

export type FakeUi = RetitleUiContext & {
  readonly toasts: Array<{ variant?: ToastVariant; message: string }>
  readonly selects: Array<{ title: string; options: ReadonlyArray<SelectOption<unknown>> }>
  readonly prompts: Array<string | undefined>
}

/** A dialog that answers each call from a queue; `undefined` cancels. */
export function fakeUi(answers: {
  readonly select?: Array<string | boolean | undefined>
  readonly prompt?: Array<string | undefined>
}): FakeUi {
  const toasts: FakeUi["toasts"] = []
  const selects: FakeUi["selects"] = []
  const selectQueue = [...(answers.select ?? [])]
  const promptQueue = [...(answers.prompt ?? [])]

  const dialog: DialogApi = {
    select<Value>(options: {
      readonly title: string
      readonly options: ReadonlyArray<SelectOption<Value>>
      readonly current?: Value
    }) {
      selects.push({ title: options.title, options: options.options as ReadonlyArray<SelectOption<unknown>> })
      return Promise.resolve(selectQueue.shift() as Value | undefined)
    },
    prompt() {
      return Promise.resolve(promptQueue.shift())
    },
  }

  const toast: ToastApi = {
    show(options) {
      toasts.push({ variant: options.variant, message: options.message })
    },
  }

  return {
    ui: {
      dialog,
      toast,
      router: { current: () => ({ type: "session", sessionID: "ses_current" }) },
    },
    toasts,
    selects,
    prompts: promptQueue,
  } as FakeUi
}

export function fakeUiAtHome(): FakeUi {
  const base = fakeUi({})
  return {
    ui: { ...base.ui, router: { current: () => ({ type: "home" as const }) } },
    toasts: base.toasts,
    selects: base.selects,
    prompts: base.prompts,
  } as unknown as FakeUi
}

/** A promise that never settles, for deadline tests. */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

export function userMessage(text: string) {
  return { type: "user", text }
}

export function assistantMessage(text: string, model?: { id: string; providerID: string; variant?: string }) {
  return { type: "assistant", content: [{ type: "text", text }], ...(model ? { model } : {}) }
}
