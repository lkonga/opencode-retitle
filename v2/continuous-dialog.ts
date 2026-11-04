import type { RetitleAdapter } from "./adapter"
import type { RetitleUiContext, SelectOption } from "./dialogs"
import { readContinuous } from "./continuous-settings"
import { applyRetitleTitle } from "./runner"

export function continuousMenuOptions(adapter: RetitleAdapter, sessionID: string): SelectOption<string>[] {
  const settings = readContinuous(adapter.settings.read().continuous)
  const count = adapter.candidates?.pending(sessionID).length ?? 0
  return [
    { title: `Continuous: ${settings.enabled ? "On" : "Off"}`, value: "continuous", category: "Continuous" },
    { title: `Mode: ${settings.mode === "semantic" ? "Semantic" : "Cadence"}`, value: "continuous-mode", category: "Continuous" },
    { title: `Shadow Mode: ${settings.shadowMode ? "On" : "Off"}`, value: "continuous-shadow", category: "Continuous" },
    ...(count ? [{ title: `Review Queued Titles (${count} pending)`, value: "continuous-review", category: "Continuous" }] : []),
  ]
}

export async function handleContinuousAction(
  context: RetitleUiContext, adapter: RetitleAdapter, sessionID: string, action: string,
): Promise<boolean> {
  if (!action.startsWith("continuous")) return false
  if (action === "continuous-review") {
    await review(context, adapter, sessionID)
    return true
  }
  const settings = readContinuous(adapter.settings.read().continuous)
  const next = action === "continuous" ? { ...settings, enabled: !settings.enabled }
    : action === "continuous-mode" ? { ...settings, mode: settings.mode === "semantic" ? "cadence" as const : "semantic" as const }
    : action === "continuous-shadow" ? { ...settings, shadowMode: !settings.shadowMode } : undefined
  if (!next) return false
  try { await adapter.settings.setContinuous?.(next) }
  catch (error) { adapter.logger.event("settings-write-error", { error }) }
  return true
}

async function review(context: RetitleUiContext, adapter: RetitleAdapter, sessionID: string): Promise<void> {
  const queue = adapter.candidates
  if (!queue) return
  for (;;) {
    const candidates = queue.pending(sessionID)
    if (!candidates.length) return
    const id = await context.ui.dialog.select<number>({ title: "Queued Titles", current: candidates[0]!.id,
      options: candidates.map((c) => ({ title: c.proposedTitle, value: c.id, description: `${c.previousTitle} → ${c.proposedTitle}` })) })
    const candidate = candidates.find((c) => c.id === id)
    if (!candidate) return
    const action = await context.ui.dialog.select<string>({ title: candidate.proposedTitle, current: "apply", options: [
      { title: "Apply title", value: "apply" }, { title: "Edit title", value: "edit" }, { title: "Reject title", value: "reject" },
    ] })
    if (action === "reject") { await queue.reject(candidate.id); continue }
    if (action !== "apply" && action !== "edit") return
    let title = candidate.proposedTitle
    if (action === "edit") {
      const edited = await context.ui.dialog.prompt({ title: "Edit proposed title", value: title })
      if (!edited?.trim()) return
      title = edited.trim()
    }
    // Selecting a candidate then the default Apply is the double-Enter path.
    if (!queue.pending(sessionID).some((c) => c.id === id)) return
    const result = await applyRetitleTitle(adapter.ports, sessionID, title, adapter.logger)
    if (!result.ok) {
      context.ui.toast.show({ message: result.message, variant: "error" })
      return
    }
    await queue.accept(candidate.id)
    await queue.invalidateForeignRename(sessionID)
  }
}
