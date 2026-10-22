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
import { retitleKeymapLayer } from "./command"
import { openRetitle, openRetitleAuto } from "./dialogs"
import type { ProgressSurface } from "./progress"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/**
 * Binds the render-free progress surface to the documented public dialog
 * lifecycle: `dialog.show(render)` renders, `dialog.clear()` dismisses.
 * `dialog.set(...)` is deliberately not used — it carries presentation options
 * (`{ size, centered }`), not content (`packages/plugin/src/tui/context.ts:341`).
 * Both calls are guarded so a runtime revision that stops publishing the dialog
 * degrades to "no progress" instead of failing the run; `progress.ts` owns the
 * lifetime and the token safety.
 */
function dialogProgressSurface(dialog: Plugin.Context["ui"]["dialog"] | undefined): ProgressSurface {
  return {
    set(message) {
      if (!dialog || typeof dialog.show !== "function") return
      dialog.show(() => (
        <box paddingLeft={2} paddingRight={2}>
          <text>{message}</text>
        </box>
      ))
    },
    clear() {
      if (!dialog || typeof dialog.clear !== "function") return
      dialog.clear()
    },
  }
}

function Commands(props: {
  context: Plugin.Context
  adapter: ReturnType<typeof createRetitleAdapter>
  onStart: (label: string) => void
  onEnd: () => void
}) {
  // `keymap.layer` is scoped to this component, so the layer is registered
  // exactly once per activation and is disposed with the plugin.
  props.context.keymap.layer(() =>
    retitleKeymapLayer(
      async (rawArgs) => {
        props.onStart("/retitle")
        try {
          await openRetitle(props.context, props.adapter, rawArgs)
        } finally {
          props.onEnd()
        }
      },
      async (rawArgs) => {
        props.onStart("/retitle-auto")
        try {
          await openRetitleAuto(props.context, props.adapter, rawArgs)
        } finally {
          props.onEnd()
        }
      },
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
    const adapter = createRetitleAdapter(toRetitleContext(context), {
      progressSurface: dialogProgressSurface(context.ui?.dialog),
    })

    const [activeLabel, setActiveLabel] = createSignal<string | null>(null)

    // Footer status slot in /btw style: shows animated spinner and command label while in-flight
    context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const color = () => context.theme?.hue?.interactive?.[200] ?? context.theme?.text?.muted
        return (
          <Show when={activeLabel()}>
            {(label) => (
              <box flexShrink={0} flexDirection="row" gap={1}>
                <spinner frames={SPINNER_FRAMES} interval={80} color={color()} />
                <text fg={color()}>{label()}</text>
              </box>
            )}
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
          onStart={(label) => setActiveLabel(label)}
          onEnd={() => setActiveLabel(null)}
        />
      ),
    })
  },
})
