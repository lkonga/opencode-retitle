/** @jsxImportSource @opentui/solid */
// OpenCode V2 TUI entrypoint for /retitle, /retitle-auto, and /retitle-auto-sessions.
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
import { createBatchController } from "./batch"
import { RETITLE_AUTO_SESSIONS_SLASH_NAME, RETITLE_AUTO_SLASH_NAME, retitleKeymapLayer } from "./command"
import { openRetitle, openRetitleAuto } from "./dialogs"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function Commands(props: {
  context: Plugin.Context
  adapter: ReturnType<typeof createRetitleAdapter>
  batchController: ReturnType<typeof createBatchController>
  onAutoPendingChange: (delta: 1 | -1) => void
  onInteractivePendingChange: (delta: 1 | -1) => void
  onBatchPendingChange: (delta: 1 | -1) => void
  onBatchProgress: (text: string | undefined) => void
}) {
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
      async (rawArgs) => {
        await props.batchController.run(rawArgs, {
          onPendingChange: props.onBatchPendingChange,
          onProgress: (p) => props.onBatchProgress(p.text),
        })
      },
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
    const batchController = createBatchController(context, adapter, context.data)

    const [pendingAuto, setPendingAuto] = createSignal(0)
    const [pendingInteractive, setPendingInteractive] = createSignal(0)
    const [pendingBatch, setPendingBatch] = createSignal(0)
    const [batchText, setBatchText] = createSignal<string | undefined>(undefined)

    // Auto status follows granted runs, and takes priority over rejected commands.
    context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        return (
          <Show when={pendingBatch() > 0 || pendingAuto() > 0 || pendingInteractive() > 0}>
            <box flexShrink={0} flexDirection="row" gap={1}>
              <spinner frames={SPINNER_FRAMES} interval={80} />
              <text>
                {pendingBatch() > 0
                  ? (batchText() ?? `/${RETITLE_AUTO_SESSIONS_SLASH_NAME}`)
                  : pendingAuto() > 0
                    ? `/${RETITLE_AUTO_SLASH_NAME}`
                    : "/retitle"}
              </text>
            </box>
          </Show>
        )
      },
    })

    return context.ui.slot({
      append: "app",
      render: () => (
        <Commands
          context={context}
          adapter={adapter}
          batchController={batchController}
          onAutoPendingChange={(delta) => setPendingAuto((n) => Math.max(0, n + delta))}
          onInteractivePendingChange={(delta) => setPendingInteractive((n) => Math.max(0, n + delta))}
          onBatchPendingChange={(delta) => {
            setPendingBatch((n) => {
              const next = Math.max(0, n + delta)
              if (next === 0) setBatchText(undefined)
              return next
            })
          }}
          onBatchProgress={(text) => setBatchText(text)}
        />
      ),
    })
  },
})
