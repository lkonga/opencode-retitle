// The /retitle, /retitle-auto, and /retitle-auto-sessions command registrations.
//
// "Exactly once, in both the slash menu and the palette" is a structural
// property here, not a convention: one command object carries both `palette`
// and `slash`, and the layer returns exactly one object per command. There is no second
// slash-only or palette-only registration that could double up.
//
// `mode: "global"` is required, not cosmetic. A plugin layer defaults to base
// mode (`packages/tui/src/context/keymap.tsx:213`), and the prompt pushes the
// `autocomplete` mode while the slash menu is open
// (`packages/tui/src/component/prompt/autocomplete.tsx:103`). Both the slash
// menu and the palette read the *reachable* command view
// (`packages/tui/src/context/keymap.tsx:303-330`), so a base-mode layer would
// be filtered out exactly when /retitle needs to be offered. Global layers
// register with no mode field and match every mode.
//
// `bind` is present, and it is a **fixed** stroke, not a config keybind:
//
//   * A reachable V2 command carries a raw binding, so the command is one
//     reachable entry with both its palette/slash reachability and its key
//     stroke — not a palette-only entry that happens to be reachable.
//   * The binding is deliberately NOT declared in the runtime's canonical
//     `cli.json` keybind table. `TuiKeybind.parse` rejects any key it does not
//     know (`packages/tui/src/config/keybind.ts`, `parse`/`unknownKeys`), so a
//     user who adds `retitle.session.retitle` to `keybinds` gets a fatal
//     "Unrecognized keybind" instead of a remap. The stroke therefore ships
//     with the plugin and cannot be remapped without editing this file.
//   * `ctrl+shift+r` was checked against all 218 TUI default bindings in
//     `packages/tui/src/config/keybind.ts` (no collision; the nearest
//     neighbours are `session.rename` = `ctrl+r`, `session.tab.reopen` =
//     `ctrl+shift+t`, `input.delete.line` = `ctrl+shift+d`) and against the
//     live `keybinds` block of `<config>/cli.json`. See `v2/README.md`.

export const RETITLE_COMMAND_ID = "retitle.session.retitle"
export const RETITLE_SLASH_NAME = "retitle"
export const RETITLE_AUTO_COMMAND_ID = "retitle.session.retitle_auto"
export const RETITLE_AUTO_SLASH_NAME = "retitle-auto"
export const RETITLE_AUTO_SESSIONS_COMMAND_ID = "retitle.session.retitle_auto_sessions"
export const RETITLE_AUTO_SESSIONS_SLASH_NAME = "retitle-auto-sessions"
/** Fixed, non-remappable key stroke for the command (see the header). */
export const RETITLE_BIND = "ctrl+shift+r"

export type RetitleCommandKind = "interactive" | "auto" | "batch"

export interface RetitleKeymapCommand {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly group: string
  readonly bind?: string
  readonly palette: true
  readonly slash: { readonly name: string; readonly arguments: true }
  readonly run: (input?: string) => void
}

export interface RetitleKeymapLayer {
  readonly mode: "global"
  readonly commands: readonly RetitleKeymapCommand[]
}

export function createRetitleCommand(
  handler: (rawArgs: string) => void | Promise<void>,
  onError?: (error: unknown) => void,
): RetitleKeymapCommand {
  return createCommand("interactive", handler, onError)
}

export function createRetitleAutoCommand(
  handler: (rawArgs: string) => void | Promise<void>,
  onError?: (error: unknown) => void,
): RetitleKeymapCommand {
  return createCommand("auto", handler, onError)
}

export function createRetitleAutoSessionsCommand(
  handler: (rawArgs: string) => void | Promise<void>,
  onError?: (error: unknown) => void,
): RetitleKeymapCommand {
  return createCommand("batch", handler, onError)
}

function createCommand(
  kind: RetitleCommandKind,
  handler: (rawArgs: string) => void | Promise<void>,
  onError?: (error: unknown) => void,
): RetitleKeymapCommand {
  let id: string
  let title: string
  let description: string
  let slashName: string
  let bind: string | undefined

  switch (kind) {
    case "interactive":
      id = RETITLE_COMMAND_ID
      title = "Retitle Session (Recent)"
      description = "Retitle the session from sampled recent turns. Args: [hint], --samples N, --from P%, --offset N"
      slashName = RETITLE_SLASH_NAME
      bind = RETITLE_BIND
      break
    case "auto":
      id = RETITLE_AUTO_COMMAND_ID
      title = "Retitle Session (Auto)"
      description =
        "Generate and apply a title with current settings, without dialogs. Args: [hint], --samples N, --from P%, --offset N"
      slashName = RETITLE_AUTO_SLASH_NAME
      break
    case "batch":
      id = RETITLE_AUTO_SESSIONS_COMMAND_ID
      title = "Retitle All Open Sessions (Auto)"
      description =
        "Generate and apply titles for all open session tabs in parallel without dialogs. Args: [hint], --samples N, --from P%, --offset N"
      slashName = RETITLE_AUTO_SESSIONS_SLASH_NAME
      break
  }

  return {
    id,
    title,
    description,
    group: "Session",
    ...(bind ? { bind } : {}),
    palette: true,
    slash: { name: slashName, arguments: true },
    run: (input) => {
      // The handler owns its own error surface (it toasts); anything escaping it
      // is a bug that must not become an unhandled rejection in the keymap.
      void Promise.resolve()
        .then(() => handler(input ?? ""))
        .catch((error) => onError?.(error))
    },
  }
}

/**
 * Keymap contribution factory:
 * - 2 args: `(handler, autoHandler)` -> 2 commands
 * - 3 args: `(handler, autoHandler, onError)` -> 2 commands (preserves legacy signature position)
 * - 4 args: `(handler, autoHandler, onError, batchHandler)` -> 3 commands
 */
export function retitleKeymapLayer(
  handler: (rawArgs: string) => void | Promise<void>,
  autoHandler: (rawArgs: string) => void | Promise<void>,
  onError?: (error: unknown) => void,
  batchHandler?: (rawArgs: string) => void | Promise<void>,
): RetitleKeymapLayer {
  const commands: RetitleKeymapCommand[] = [
    createRetitleCommand(handler, onError),
    createRetitleAutoCommand(autoHandler, onError),
  ]

  if (batchHandler) {
    commands.push(createRetitleAutoSessionsCommand(batchHandler, onError))
  }

  return { mode: "global", commands }
}
