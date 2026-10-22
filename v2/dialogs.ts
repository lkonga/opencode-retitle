// Lifecycle for /retitle and /retitle-auto: run gate -> settings -> generation ->
// confirm -> apply.
//
// Two entry points share one lifecycle and one run gate, and differ only in
// whether the user is asked anything:
//
//   * `openRetitle` (interactive) walks the settings dialog and the confirm
//     menu, so a run is only written after an explicit Apply/Edit.
//   * `openRetitleAuto` (`/retitle-auto`, unattended) never opens, shows or
//     clears a dialog: settings come from the saved state plus the raw args, the
//     first title is applied as-is, and every failure is reported through the
//     log and a toast only.
//
// This module owns the *lifecycle*, not the API. It reads `Plugin.Context`'s
// documented dialog/toast/router surface through a structural type, which keeps
// the whole flow testable with a fake dialog that returns queued answers.
//
// Ordering guarantees:
//   * the run gate is claimed synchronously before any `await`, so a second
//     invocation (double Enter, palette + slash, or /retitle racing
//     /retitle-auto) is rejected instead of opening a second dialog or starting
//     a second generation;
//   * the gate is released in `finally`, so a thrown dialog, a cancelled
//     dialog, or a failed generation can never wedge either command;
//   * interactive `/retitle` writes a title only after an explicit Apply/Edit
//     confirmation, so a failure can never leave a half-applied title;
//     `/retitle-auto` writes the first candidate by design, which is why it is
//     reachable only from the palette and the slash menu — never a key stroke;
//   * progress is run-scoped (`progress.ts`): a granted run owns one lane and
//     releases it in `finally`, so a denied duplicate invocation cannot dismiss
//     the active run's surface and no surface can outlive its run.

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
import {
  PROGRESS_APPLYING,
  PROGRESS_GENERATING,
  withProgress,
  type ProgressRun,
} from "./progress"
import { applyRetitleTitle, executeRetitle, type RetitleOutcome } from "./runner"
import type { GateGrant } from "./gate"

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
const AUTO_NO_SESSION_MESSAGE = "Open a session before using /retitle-auto"
const IN_FLIGHT_MESSAGE = "Retitle already running"

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

  const grant = claimRun(context, adapter)
  if (!grant) return

  // Only a granted run owns a progress lane, so a denied duplicate invocation
  // (which returns above) can never clear the active run's progress. The lane is
  // released in `finally`, alongside the gate.
  const run = adapter.progress.run()
  try {
    const settings = settingsFromArgs(adapter.settings.read(), rawArgs)
    await settingsDialog(context, adapter, sessionID, settings, run)
  } finally {
    run.release()
    adapter.gate.end(grant.token)
  }
}

/**
 * Entry point for `/retitle-auto`: one unattended pass, no UI. The session is
 * verified, the gate is claimed synchronously, settings come from the saved
 * state plus the raw args, and the first candidate title is applied directly.
 * Nothing on this path may open a dialog, so the settings dialog and confirm
 * menu are skipped entirely; failures only log and toast.
 */
export async function openRetitleAuto(
  context: RetitleUiContext,
  adapter: RetitleAdapter,
  rawArgs: string,
  onPendingChange?: (delta: 1 | -1) => void,
): Promise<void> {
  const route = context.ui.router.current()
  const sessionID = route?.type === "session" ? route.sessionID : undefined
  if (!sessionID) {
    adapter.logger.event("no-session", { route: route?.type ?? "unknown", auto: true })
    toast(context, adapter, "no-session", "warning", AUTO_NO_SESSION_MESSAGE)
    return
  }

  const grant = claimRun(context, adapter)
  if (!grant) return

  // `silent` keeps the run's lane and its progress logs but suppresses surface
  // set/clear: in production the surface is `dialog.show`, which this path must
  // never touch.
  const run = adapter.progress.run({ silent: true })
  // Inventory observers must not interrupt the run or its cleanup.
  const notifyPending = (delta: 1 | -1) => {
    try {
      onPendingChange?.(delta)
    } catch {
      // A status observer is best-effort, not part of the retitle operation.
    }
  }
  try {
    notifyPending(1)
    const settings = settingsFromArgs(adapter.settings.read(), rawArgs)
    const outcome = await withProgress(run, PROGRESS_GENERATING, "generating", () =>
      executeRetitle(adapter.ports, { sessionID, settings, logger: adapter.logger }),
    )

    if (outcome.status !== "ok") {
      // Failure surface only: `handleOutcome` never opens a dialog for a non-ok
      // outcome (it logs and toasts), and its "reopen" answer is meaningless
      // here because there is no settings loop to return to.
      await handleOutcome(context, adapter, sessionID, outcome, run)
      return
    }

    const label = `${outcome.model.providerID}/${outcome.model.modelID}`
    adapter.logger.event("auto-apply", { sessionID, model: label })
    await applyConfirmedTitle(context, adapter, sessionID, outcome.title, label, run)
  } catch (error) {
    // `executeRetitle` reports its own failures, so a throw here is unexpected.
    // It must still leave the toast as the only trace and release the lane.
    adapter.logger.event("auto-error", { sessionID, error })
    toast(context, adapter, "auto-error", "error", "Retitle (auto) failed unexpectedly")
  } finally {
    try {
      run.release()
    } finally {
      try {
        adapter.gate.end(grant.token)
      } finally {
        notifyPending(-1)
      }
    }
  }
}

/**
 * Claims the shared run gate synchronously, before any `await`. Interactive and
 * auto runs go through the same helper, so each rejects the other with the same
 * log event and the same toast.
 */
function claimRun(context: RetitleUiContext, adapter: RetitleAdapter): GateGrant | undefined {
  const grant = adapter.gate.begin()
  if (grant.ok) return grant
  adapter.logger.event("rejected", { reason: grant.reason })
  if (grant.reason === "in-flight") toast(context, adapter, "in-flight", "warning", IN_FLIGHT_MESSAGE)
  return undefined
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
  run: ProgressRun,
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
      const outcome = await withProgress(run, PROGRESS_GENERATING, "generating", () =>
        executeRetitle(adapter.ports, { sessionID, settings, logger: adapter.logger }),
      )
      const next = await handleOutcome(context, adapter, sessionID, outcome, run)
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
  run: ProgressRun,
): Promise<"done" | "reopen"> {
  if (outcome.status === "ok") {
    const label = `${outcome.model.providerID}/${outcome.model.modelID}`
    return confirmMenu(context, adapter, sessionID, outcome.title, label, run)
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
  run: ProgressRun,
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
    await applyConfirmedTitle(context, adapter, sessionID, title, modelLabel, run)
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
    await applyConfirmedTitle(context, adapter, sessionID, trimmed, modelLabel, run)
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
  run: ProgressRun,
): Promise<boolean> {
  // The write reports its own progress; the port resolves only after the
  // reactive refresh, so the success toast below always follows write+refresh.
  const result = await withProgress(run, PROGRESS_APPLYING, "applying", () =>
    applyRetitleTitle(adapter.ports, sessionID, title, adapter.logger),
  )
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
