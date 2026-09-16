// The single /retitle command registration.
//
// "Exactly once, in both the slash menu and the palette" is a structural
// property here, not a convention: one command object carries both `palette`
// and `slash`, and the layer returns exactly that object. There is no second
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

export const RETITLE_COMMAND_ID = "retitle.session.retitle"
export const RETITLE_SLASH_NAME = "retitle"

export interface RetitleKeymapCommand {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly group: string
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
  return {
    id: RETITLE_COMMAND_ID,
    title: "Retitle Session (Recent)",
    description: "Retitle the session from sampled recent turns. Args: [hint], --samples N, --from P%, --offset N",
    group: "Session",
    palette: true,
    slash: { name: RETITLE_SLASH_NAME, arguments: true },
    run: (input) => {
      // The handler owns its own error surface (it toasts); anything escaping it
      // is a bug that must not become an unhandled rejection in the keymap.
      void Promise.resolve()
        .then(() => handler(input ?? ""))
        .catch((error) => onError?.(error))
    },
  }
}

/** The plugin's complete keymap contribution: exactly one layer, one command. */
export function retitleKeymapLayer(
  handler: (rawArgs: string) => void | Promise<void>,
  onError?: (error: unknown) => void,
): RetitleKeymapLayer {
  return { mode: "global", commands: [createRetitleCommand(handler, onError)] }
}
