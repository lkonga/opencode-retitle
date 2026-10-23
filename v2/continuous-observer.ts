import { createEffect } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type { RetitleAdapter } from "./adapter"
import { ContinuousRetitle } from "./continuous"
import { normalizeMessages, type RawSessionMessage } from "./retitle-core"

/** Scoped to the app component: Solid disposes the observer with the plugin. */
export function observeContinuous(context: Plugin.Context, adapter: RetitleAdapter,
  autoApply: (adapter: RetitleAdapter) => Promise<void>, changed: () => void): void {
  const evaluator = new ContinuousRetitle(adapter, async (sessionID, guarded) => {
    // Auto's session is resolved synchronously before its first await.
    const route = context.ui.router.current()
    if (route.type !== "session" || route.sessionID !== sessionID) return
    await autoApply(guarded)
    return (context.data.session.get(sessionID) as { readonly title?: string } | undefined)?.title
  }, changed)
  createEffect(() => {
    const route = context.ui.router.current()
    if (route.type !== "session") return
    const session = context.data.session.get(route.sessionID) as { readonly title?: string } | undefined
    const raw = context.data.session.message.list(route.sessionID) as ReadonlyArray<RawSessionMessage>
    const messages = normalizeMessages(raw).filter((message) => message.role === "user")
    // Track settings so opting in does not require a route change.
    adapter.settings.read()
    void evaluator.observe({ sessionID: route.sessionID, title: session?.title ?? "",
      turnIndex: messages.length, text: messages.at(-1)?.text ?? "" }).catch((error) => {
        adapter.logger.event("continuous-observer-error", { error })
      })
  })
}
