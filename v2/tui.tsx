/** @jsxImportSource @opentui/solid */
// OpenCode V2 TUI entrypoint for /retitle and /retitle-auto.
//
// This file is deliberately tiny: it mounts one component in the `app` slot and
// registers one keymap layer. All behaviour lives in the modules it imports, so
// the lifecycle (gate/cleanup/timeout) and the API adapter stay testable without
// a TUI.
//
// Public V2 boundary only:
//   * `Plugin.define({ id, setup })`                    `@opencode/plugin/tui`
//   * `context.ui.slot({ append: "app", render })`      `@opencode/plugin/tui/context` (UI.slot)
//   * `context.keymap.layer(() => KeymapLayer)`         `@opencode/plugin/tui/context` (Keymap.layer)
//   * `context.client` / `context.data` / `context.storage` / `context.ui.*`
//
// The V1 entrypoint (`../tui.ts`) is untouched and still loads under V1.

import { createSignal, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { createRetitleAdapter, toRetitleContext } from "./adapter"
import { RETITLE_AUTO_SLASH_NAME, retitleKeymapLayer } from "./command"
import { openRetitle, openRetitleAuto } from "./dialogs"
import { observeContinuous } from "./continuous-observer"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function Commands(props: {
  context: Plugin.Context
  adapter: ReturnType<typeof createRetitleAdapter>
  onAutoPendingChange: (delta: 1 | -1) => void
  onInteractivePendingChange: (delta: 1 | -1) => void
  onCandidatesChange: () => void
}) {
  observeContinuous(props.context, props.adapter,
    (adapter) => openRetitleAuto(props.context, adapter, undefined, props.onAutoPendingChange), props.onCandidatesChange)
  // `keymap.layer` is scoped to this component, so the layer is registered
  // exactly once per activation and is disposed with the plugin.
  props.context.keymap.layer(() =>
    retitleKeymapLayer(
      async (rawArgs) => {
        props.onInteractivePendingChange(1)
        try {
          await openRetitle(props.context, props.adapter, rawArgs)
        } finally {
          props.onInteractivePendingChange(-1)
        }
      },
      (rawArgs) => openRetitleAuto(props.context, props.adapter, rawArgs, props.onAutoPendingChange),
      (error) => props.adapter.logger.event("command-error", { error }),
    ),
  )

  return null
}

export default Plugin.define({
  id: "opencode-retitle-v2-tui",
  setup: (context) => {
    // One adapter per activation: it owns the run gate, the log, the debouncer,
    // the progress controller and the durable settings store, all created
    // through public context APIs. Building it here (not inside the component)
    // keeps a single gate and a single progress lane even if the slot
    // re-renders.
    // Progress is shown only by the animated footer status, never a modal.
    const adapter = createRetitleAdapter(toRetitleContext(context))

    const [pendingAuto, setPendingAuto] = createSignal(0)
    const [pendingInteractive, setPendingInteractive] = createSignal(0)
    const [candidateVersion, setCandidateVersion] = createSignal(0)
    const proposedCount = () => {
      candidateVersion()
      const route = context.ui.router.current()
      return route.type === "session" ? adapter.candidates?.pending(route.sessionID).length ?? 0 : 0
    }

    // Auto status follows granted runs, and takes priority over rejected commands.
    context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        return (
          <>
          <Show when={pendingAuto() > 0 || pendingInteractive() > 0}>
              <box flexShrink={0} flexDirection="row" gap={1}>
                <spinner frames={SPINNER_FRAMES} interval={80} />
                <text>{pendingAuto() > 0 ? `/${RETITLE_AUTO_SLASH_NAME}` : "/retitle"}</text>
              </box>
          </Show>
          <Show when={pendingAuto() === 0 && pendingInteractive() === 0 && proposedCount() > 0}>
            <text>{`⋯ ${proposedCount()} title${proposedCount() === 1 ? "" : "s"} proposed`}</text>
          </Show>
          </>
        )
      },
    })

    return context.ui.slot({
      append: "app",
      render: () => (
        <Commands
          context={context}
          adapter={adapter}
          onAutoPendingChange={(delta) => setPendingAuto((n) => Math.max(0, n + delta))}
          onInteractivePendingChange={(delta) => setPendingInteractive((n) => Math.max(0, n + delta))}
          onCandidatesChange={() => setCandidateVersion((n) => n + 1)}
        />
      ),
    })
  },
})
