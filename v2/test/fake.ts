// Shared fakes for the behavioural tests.
//
// These stand in for the public client, the host's reactive data, the durable
// storage and the dialog surface, so the adapter, the runner and the dialog
// lifecycle can be driven end to end without a TUI.

import type { SessionApiClient } from "../session-api"
import type { SettingsStorage } from "../settings"
import type { RetitleContext } from "../adapter"
import type { DialogApi, RetitleUiContext, SelectOption, ToastApi, ToastVariant } from "../dialogs"

export type Recorded = {
  readonly creates: Array<Record<string, unknown>>
  readonly generates: Array<{ sessionID: string; prompt: string }>
  readonly removes: Array<string>
  readonly renames: Array<{ sessionID: string; title: string }>
  readonly lists: Array<{ sessionID: string; limit?: number; order?: "asc" | "desc" }>
}

export type FakeClientOptions = {
  readonly create?: (input: Record<string, unknown>) => Promise<unknown> | unknown
  readonly generate?: (input: { sessionID: string; prompt: string }) => Promise<unknown> | unknown
  readonly remove?: (input: { sessionID: string }) => Promise<unknown> | unknown
  readonly rename?: (input: { sessionID: string; title: string }) => Promise<unknown> | unknown
  readonly list?: (input: { sessionID: string; limit?: number; order?: "asc" | "desc" }) => Promise<unknown> | unknown
  /** Omit `session.generate` entirely to simulate a runtime without it. */
  readonly withoutGenerate?: boolean
}

export function fakeClient(options: FakeClientOptions = {}) {
  const calls: Recorded = { creates: [], generates: [], removes: [], renames: [], lists: [] }
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
      rename: (input: { sessionID: string; title: string }) => {
        calls.renames.push(input)
        return Promise.resolve(options.rename ? options.rename(input) : undefined)
      },
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
  const state: Record<string, unknown> = { ...initial }
  const storage: SettingsStorage = {
    store<Value extends object>(_key: string, options: { readonly initial: Value }) {
      for (const [key, value] of Object.entries(options.initial)) {
        if (!(key in state)) state[key] = value
      }
      const store = state as Value
      const update = (mutation: (draft: Value) => void) => {
        const draft = { ...(state as Value) }
        mutation(draft)
        Object.assign(state, draft)
        writes.push({ ...(draft as Record<string, unknown>) })
        return Promise.resolve()
      }
      return [store, update] as const
    },
  }
  return { storage, writes, state }
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
}

export function fakeContext(input: FakeContextInput): RetitleContext & { readonly syncs: string[] } {
  const catalog = input.catalog ?? fakeCatalog()
  const syncs: string[] = []
  const messages = input.messages ?? []
  const location = Object.assign(catalog, {
    default: () => ({ directory: input.location?.directory ?? "/workspace/default" }),
  })
  return {
    client: input.client,
    location: input.location,
    data: {
      location,
      session: {
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
  } as unknown as RetitleContext & { readonly syncs: string[] }
}

export type FakeUi = RetitleUiContext & {
  readonly toasts: Array<{ variant?: ToastVariant; message: string }>
  readonly selects: Array<{ title: string; options: ReadonlyArray<SelectOption<unknown>> }>
  readonly prompts: Array<string | undefined>
}

/** A dialog that answers each call from a queue; `undefined` cancels. */
export function fakeUi(answers: {
  readonly select?: Array<string | undefined>
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
