// Dialog lifecycle for /retitle: run gate -> settings -> generation -> confirm -> apply.
//
// This module owns the *lifecycle*, not the API. It reads `Plugin.Context`'s
// documented dialog/toast/router surface through a structural type, which keeps
// the whole flow testable with a fake dialog that returns queued answers.
//
// Ordering guarantees:
//   * the run gate is claimed synchronously before any `await`, so a second
//     /retitle (double Enter, palette + slash) is rejected instead of opening a
//     second dialog or starting a second generation;
//   * the gate is released in `finally`, so a thrown dialog, a cancelled
//     dialog, or a failed generation can never wedge /retitle;
//   * a title is only written after an explicit Apply/Edit confirmation, so a
//     failure can never leave a half-applied title.

import {
  DEFAULT_FROM_PCT,
  DEFAULT_OFFSET,
  DEFAULT_SAMPLES,
  type ModelOption,
  type RetitleSettings,
} from "./retitle-core"
import { modelOptions } from "./models"
import { effectiveModelLabel, type RetitleAdapter } from "./adapter"
import { settingsFromArgs } from "./settings"
import { applyRetitleTitle, executeRetitle, type RetitleOutcome } from "./runner"

export type ToastVariant = "info" | "success" | "warning" | "error"

export interface SelectOption<Value> {
  readonly title: string
  readonly value: Value
  readonly description?: string
  readonly category?: string
  readonly disabled?: boolean
}

export interface DialogApi {
  select<Value>(options: {
    readonly title: string
    readonly placeholder?: string
    readonly options: ReadonlyArray<SelectOption<Value>>
    readonly current?: Value
  }): Promise<Value | undefined>
  prompt(options: {
    readonly title: string
    readonly description?: string
    readonly placeholder?: string
    readonly value?: string
  }): Promise<string | undefined>
}

export interface ToastApi {
  show(options: {
    readonly title?: string
    readonly message: string
    readonly variant?: ToastVariant
    readonly duration?: number
  }): void
}

export type RouteLike =
  | { readonly type: "home" }
  | { readonly type: "session"; readonly sessionID: string }
  | { readonly type: "plugin"; readonly id: string; readonly name: string }

export interface RetitleUiContext {
  readonly ui: {
    readonly dialog: DialogApi
    readonly toast: ToastApi
    readonly router: { current(): RouteLike }
  }
}

const NO_SESSION_MESSAGE = "Open a session before using /retitle"

/** Entry point for the slash command and the palette command. */
export async function openRetitle(
  context: RetitleUiContext,
  adapter: RetitleAdapter,
  rawArgs: string,
): Promise<void> {
  const route = context.ui.router.current()
  const sessionID = route?.type === "session" ? route.sessionID : undefined
  if (!sessionID) {
    adapter.logger.event("no-session", { route: route?.type ?? "unknown" })
    toast(context, adapter, "no-session", "warning", NO_SESSION_MESSAGE)
    return
  }

  const grant = adapter.gate.begin()
  if (!grant.ok) {
    adapter.logger.event("rejected", { reason: grant.reason })
    if (grant.reason === "in-flight") toast(context, adapter, "in-flight", "warning", "Retitle already running")
    return
  }

  try {
    const settings = settingsFromArgs(adapter.settings.read(), rawArgs)
    await settingsDialog(context, adapter, sessionID, settings)
  } finally {
    adapter.gate.end(grant.token)
  }
}

/**
 * V1's `settingsDialog`: a single dialog loop over the run settings. Returns
 * only when the user cancels or a run completes, so a "Regenerate" choice
 * re-enters the same loop instead of recursing back into the dialog.
 */
export async function settingsDialog(
  context: RetitleUiContext,
  adapter: RetitleAdapter,
  sessionID: string,
  settings: RetitleSettings,
): Promise<void> {
  for (;;) {
    const catalog = adapter.catalog()
    const modelDisplay = effectiveModelLabel(catalog, settings.model)
    const action = await context.ui.dialog.select<string>({
      title: "Retitle Session",
      current: "run",
      options: [
        {
          title: "Retitle with current settings",
          value: "run",
          category: "Run",
          description: `model=${modelDisplay} samples=${settings.samples}${settings.offset > 0 ? ` offset=${settings.offset}` : ""}${settings.fromPct !== DEFAULT_FROM_PCT ? ` from=${settings.fromPct}%` : ""}${settings.steering ? " hint set" : ""}`,
        },
        {
          title: "Use defaults",
          value: "reset",
          category: "Run",
          description: "Reset sampling/hint defaults and run (keeps the saved model)",
        },
        {
          title: `Model: ${modelDisplay}`,
          value: "model",
          category: "Adjust",
          description: "LLM for title generation (saved as durable plugin state)",
        },
        { title: `Samples: ${settings.samples}`, value: "samples", category: "Adjust", description: "Max user turns to sample (3-50)" },
        {
          title: `Offset: ${settings.offset > 0 ? settings.offset : "all"}`,
          value: "offset",
          category: "Adjust",
          description: "Use only the last N messages",
        },
        {
          title: `From: ${settings.fromPct}%`,
          value: "from",
          category: "Adjust",
          description: "Sampling center point (0-100, 100 = end)",
        },
        { title: `Hint: ${settings.steering || "(none)"}`, value: "hint", category: "Adjust", description: "Steering hint for the title model" },
      ],
    })

    if (action === undefined) return

    if (action === "run" || action === "reset") {
      if (action === "reset") {
        settings.samples = DEFAULT_SAMPLES
        settings.offset = DEFAULT_OFFSET
        settings.fromPct = DEFAULT_FROM_PCT
        settings.steering = ""
      }
      const outcome = await executeRetitle(adapter.ports, { sessionID, settings, logger: adapter.logger })
      const next = await handleOutcome(context, adapter, sessionID, outcome)
      if (next === "done") return
      continue
    }

    if (action === "model") {
      const picked = await modelPicker(context, adapter, settings.model)
      if (picked !== undefined) settings.model = picked
      continue
    }

    if (action === "samples") {
      const picked = await numberPicker(context, "Samples", settings.samples, [3, 5, 10, 15, 20, 30, 50])
      if (picked !== undefined) settings.samples = picked
      continue
    }

    if (action === "offset") {
      const picked = await numberPicker(context, "Offset", settings.offset, [0, 10, 20, 30, 50, 100], "0 = all messages")
      if (picked !== undefined) settings.offset = picked
      continue
    }

    if (action === "from") {
      const picked = await numberPicker(context, "From %", settings.fromPct, [0, 25, 50, 75, 100])
      if (picked !== undefined) settings.fromPct = picked
      continue
    }

    if (action === "hint") {
      const picked = await context.ui.dialog.prompt({
        title: "Steering hint",
        value: settings.steering,
        placeholder: "e.g. focus on the Docker deployment work",
      })
      if (picked !== undefined) settings.steering = picked.trim()
      continue
    }

    // An unrecognized action (a dialog whose options changed under us) must end
    // the loop rather than spin on it.
    adapter.logger.event("unknown-settings-action", { sessionID })
    return
  }
}

async function handleOutcome(
  context: RetitleUiContext,
  adapter: RetitleAdapter,
  sessionID: string,
  outcome: RetitleOutcome,
): Promise<"done" | "reopen"> {
  if (outcome.status === "ok") {
    const label = `${outcome.model.providerID}/${outcome.model.modelID}`
    return confirmMenu(context, adapter, sessionID, outcome.title, label)
  }
  if (outcome.status === "empty") {
    adapter.logger.event("outcome-empty", { sessionID, messageCount: outcome.messageCount })
    toast(context, adapter, "empty", "warning", "Nothing to retitle yet: this session has no user turns to sample")
    return "done"
  }
  if (outcome.status === "no-title") {
    const label = outcome.model.providerID + "/" + outcome.model.modelID
    adapter.logger.event("outcome-no-title", { sessionID, providerID: outcome.model.providerID })
    toast(
      context,
      adapter,
      `no-title:${label}`,
      "warning",
      `No title came back from ${label}. Pick another model in settings.`,
    )
    return "reopen"
  }
  adapter.logger.event("outcome-error", { sessionID, code: outcome.code })
  toast(context, adapter, `error:${outcome.code}`, "error", outcome.message)
  return "reopen"
}

async function confirmMenu(
  context: RetitleUiContext,
  adapter: RetitleAdapter,
  sessionID: string,
  title: string,
  modelLabel: string,
): Promise<"done" | "reopen"> {
  const action = await context.ui.dialog.select<string>({
    title: `Retitle - "${title}"`,
    current: "apply",
    options: [
      { title: "Apply", value: "apply", description: "Set this as the session title" },
      { title: "Edit...", value: "edit", description: "Modify the title before applying" },
      { title: "Regenerate", value: "regenerate", description: "Run again with different settings" },
      { title: "Cancel", value: "cancel", description: "Discard this title" },
    ],
  })

  if (action === "apply") {
    await applyConfirmedTitle(context, adapter, sessionID, title, modelLabel)
    return "done"
  }
  if (action === "edit") {
    const edited = await context.ui.dialog.prompt({ title: "Edit title", value: title, placeholder: "Session title" })
    if (edited === undefined) return "done"
    const trimmed = edited.trim()
    if (!trimmed) {
      // An empty edit discards the candidate rather than writing an empty title.
      adapter.logger.event("edit-empty", { sessionID })
      return "done"
    }
    await applyConfirmedTitle(context, adapter, sessionID, trimmed, modelLabel)
    return "done"
  }
  if (action === "regenerate") return "reopen"
  adapter.logger.event("discarded", { sessionID })
  return "done"
}

export async function applyConfirmedTitle(
  context: RetitleUiContext,
  adapter: RetitleAdapter,
  sessionID: string,
  title: string,
  modelLabel: string,
): Promise<boolean> {
  const result = await applyRetitleTitle(adapter.ports, sessionID, title, adapter.logger)
  if (!result.ok) {
    toast(context, adapter, `apply-error:${result.code}`, "error", "Failed to update session title")
    return false
  }
  adapter.logger.event("applied", { sessionID, model: modelLabel, titleLength: title.length })
  toast(context, adapter, "applied", "success", `New title: ${title}`)
  return true
}

async function modelPicker(
  context: RetitleUiContext,
  adapter: RetitleAdapter,
  current: string,
): Promise<string | undefined> {
  const options: ModelOption[] = modelOptions(adapter.catalog(), current)
  const picked = await context.ui.dialog.select<string>({
    title: "Retitle model",
    placeholder: "Search models...",
    current,
    options: [...options, { title: "<- Back", value: "__back__", category: "Navigation" }],
  })
  if (picked === undefined || picked === "__back__") return undefined

  try {
    await adapter.settings.setModel(picked)
  } catch (error) {
    adapter.logger.event("settings-write-error", { error })
    toast(context, adapter, "settings-write", "error", "Could not save the model selection")
    return undefined
  }
  adapter.logger.event("model-saved", { hasOverride: Boolean(picked) })
  toast(context, adapter, "model-saved", "success", picked ? `Model: ${picked}` : "Model: title agent / auto")
  return picked
}

async function numberPicker(
  context: RetitleUiContext,
  title: string,
  current: number,
  choices: ReadonlyArray<number>,
  description?: string,
): Promise<number | undefined> {
  const picked = await context.ui.dialog.select<string>({
    title,
    current: String(current),
    options: choices.map((value) => ({
      title: String(value),
      value: String(value),
      description: value === current ? "<- current" : description,
    })),
  })
  if (picked === undefined) return undefined
  const parsed = Number(picked)
  return Number.isFinite(parsed) ? parsed : undefined
}

function toast(
  context: RetitleUiContext,
  adapter: RetitleAdapter,
  key: string,
  variant: ToastVariant,
  message: string,
): void {
  if (!adapter.toastAllowed(key)) {
    adapter.logger.event("toast-debounced", { key, variant })
    return
  }
  context.ui.toast.show({ variant, title: "Retitle", message, duration: 6000 })
}
