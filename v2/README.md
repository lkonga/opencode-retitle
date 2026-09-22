# opencode-retitle — V2 port

V2 TUI implementation of `/retitle` (issue
[#239](https://github.com/lkonga/opencode-patches/issues/239), superseding the
deferred [#226](https://github.com/lkonga/opencode-patches/issues/226)): regenerate
the current session's title from a bounded sample of its conversation, on demand.

* V2 only — this directory is a separate package (`opencode-retitle-v2`) and
  nothing here loads under V1.
* V1 is untouched byte-for-byte: `../tui.ts`, `../package.json` and `../README.md`
  are unchanged, and `v2/test/tui-contract.test.ts` pins their hashes. The
  repository-root README documents the **V1** plugin; its `tui.json`
  installation instructions do not apply to V2.
* Native audit (what the runtime already does, what it does not, and which
  public APIs `/retitle` reuses): [`NATIVE-AUDIT.md`](./NATIVE-AUDIT.md).

## Files

| File | Purpose |
|---|---|
| `tui.tsx` | V2 TUI entrypoint. One `app` slot claim, one keymap layer. No logic. |
| `command.ts` | The single `/retitle` command (palette + slash + the fixed `ctrl+shift+r` binding in one registration) and the `mode: "global"` layer factory. |
| `dialogs.ts` | Lifecycle: run gate → settings dialog → run → confirm (Apply/Edit/Regenerate/Cancel) → apply. |
| `runner.ts` | Pure pipeline over injected ports: sample → model → native generation → clean title. |
| `progress.ts` | Run-scoped generation/apply progress: token-safe set/clear lifecycle over a public `{ set(message), clear() }` surface. |
| `adapter.ts` | The only module that knows `Plugin.Context`; wires context → ports, settings, gate, logger. |
| `session-api.ts` | Public client-method adapter: bounded history, helper lifecycle, native generation, title write (rename **or** update), post-write refresh. |
| `models.ts` | Catalogue reads, title-model resolution and validation. |
| `retitle-core.ts` | Pure logic: arg parsing, sampling, title prompt, cleaning, result normalization. |
| `settings.ts` | Durable settings via the host's plugin storage (no config file, never the V1 config dir). |
| `logger.ts` | Redacted event log: no transcript, prompt, title or tool payload. |
| `gate.ts` | Run gate (one run at a time + double-submit debounce) and the failure-toast debouncer. |
| `deadline.ts` | Hard deadlines and `AbortSignal` plumbing. |
| `errors.ts` | Typed failures and the redaction-safe message mapping. |
| `test/*.test.ts` | Behavioural tests (`bun test`), no TUI runtime required. |

## Behaviour

1. Resolve the current session from `context.ui.router.current()`; refuse with a
   toast when no session route is active.
2. Claim the run gate. A second `/retitle` while one is running is rejected
   ("Retitle already running"); a re-entry inside the 400 ms double-submit window
   is dropped silently. The gate is released in `finally`.
3. Read **one bounded page** of history (200 messages, newest-first, reversed
   locally) and sample with V1's tail-3 + spread algorithm.
4. Resolve the title model (below). A settings override is fail-fast if the
   loaded catalogue does not carry it; a stale `agents.title.model` is skipped
   and the chain continues.
5. Create a short-lived helper session pinned to the `title` agent and the
   resolved model, call the native `session.generate` under a 45 s deadline, and
   remove the helper in `finally` (separate 5 s deadline, failures are logged and
   swallowed).
6. Clean the result (think-tag stripping, quote removal, refusal detection,
   100-char cap) and offer Apply / Edit… / Regenerate / Cancel. Only Apply/Edit
   writes the title, through `session.rename` when the runtime's generated client
   exposes it and `session.update` otherwise (the live OC2 contract), then
   refreshes the reactive session store (`data.session.invalidate` +
   `sync`) so the new title is visible. See NATIVE-AUDIT §4.1/§4.2.
7. Generation and the write each show a non-blocking progress surface
   (`Generating title…` / `Applying title…`) through the public dialog lifecycle;
   every path — cancel, deadline, failure, unexpected throw — clears it
   (`progress.ts`, NATIVE-AUDIT §7).

### Flags

`slash.arguments: true` passes the raw prompt line to the command, so the V1
dialog options can also be seeded from the command line:

```
/retitle                                    # retitle from recent messages
/retitle deployment pipeline                # steering hint
/retitle --samples 20 --from 50             # sample 20 turns from the 50% point
/retitle --offset 30 --samples 15 docker    # last 30 messages, 15 samples, hint
```

| Flag | Default | Range | Meaning |
|---|---|---|---|
| `--samples N` | 10 | 3–50 | max user turns to sample |
| `--from P` | 100 | 0–100 | percentage-based sampling centre (100 = end) |
| `--offset N` | all | ≥1 | use only the last N messages (user + assistant) |

Remaining text after the flags is the steering hint. The ranges are clamped, not
rejected: `--samples` is clamped to `3..50`, `--from` to `0..100` and `--offset`
to `>=1`. (`--offset 0` is therefore out of range and becomes `1`; the dialog's
`Offset: 0` entry means "all messages" and simply omits the flag.)

### Keybind

The command carries a raw, **fixed** binding in addition to its palette and
slash reachability:

| Stroke | Command id | Remappable? |
|---|---|---|
| `ctrl+shift+r` | `retitle.session.retitle` | no — ships with the plugin |

Why a raw binding:

* A reachable V2 command carries its own key stroke. The single command object
  therefore has an `id`, `palette`, `slash` *and* `bind`; the layer builder turns
  that into one reachable command plus one binding for it
  (`packages/tui/src/context/keymap.tsx`, `createLayer`).
* The stroke was checked against all 218 TUI defaults in
  `packages/tui/src/config/keybind.ts` (pinned source `c5f4ce3d66`): no default
  uses `ctrl+shift+r`. The nearest neighbours are `session.rename` (`ctrl+r`),
  `session.tab.reopen` (`ctrl+shift+t`) and `input.delete.line`
  (`ctrl+shift+d`); the only `mod+shift+r` in the tree is `review.toggle` in
  `packages/app`, a different (non-TUI) surface.
* It was also checked against the live `keybinds` block of the V2
  `<config>/cli.json`, which contains no `ctrl+shift+r` override. That same
  `plugins` array must list this plugin at most once — a second entry for the
  same directory would activate the keymap layer twice.
* It assumes the terminal reports modified strokes, which the runtime already
  requires for its own `ctrl+shift+t` (`session.tab.reopen`), `ctrl+shift+d`
  (`input.delete.line`) and `ctrl+shift+a/e` defaults. A terminal that folds
  `ctrl+shift+r` into `ctrl+r` simply never fires this stroke; `/retitle` stays
  reachable from the slash menu and the palette.

Why it is deliberately **not** a config keybind: `TuiKeybind.parse` rejects any
key it does not know (`packages/tui/src/config/keybind.ts`), and the plugin does
not add a `Definitions` entry to the canonical table. Adding
`retitle.session.retitle` to `cli.json`'s `keybinds` is therefore a fatal
"Unrecognized keybind" error rather than a remap. This is intentional: the
plugin's key does not require (and must not require) a change to the canonical
config, and it cannot be remapped without editing `command.ts`. `/retitle`
remains usable from the slash menu and the palette either way; the stroke is
only added convenience, and it is the plugin's only keybind.

### Title model resolution

1. settings override (chosen in the dialog, persisted as durable plugin state)
2. the built-in `title` agent's model — the V2 home of V1 `small_model`
   (`packages/core/src/config/normalize.ts:123-140`)
3. the session's current model
4. the first assistant message's model
5. the first enabled, non-deprecated catalogue model

Nothing is hardcoded, and the two kinds of configuration fail differently on
purpose:

* **The explicit override is strict and fail-closed.** If the catalogue is loaded
  and does not contain it, the run fails with `Model from settings is not
  available in this runtime: provider/model` rather than quietly generating with
  a different model.
* **The `title` agent's model is a preference, not a choice made for this run.**
  It is used only when the loaded catalogue carries it. A stale value — the live
  case is an inherited V1 `agents.title.model` naming a provider this runtime no
  longer has — is skipped, and the chain continues to the session model, the
  assistant model, or the first enabled catalogue model. The chosen fallback is
  what gets pinned to the fresh `title`-agent helper session.
* **An empty catalogue is a read failure, not a verdict.** When no catalogue
  could be read, nothing can be confirmed, so the preference chain is used
  unvalidated (the strict override rule still applies as written above).

The log records the outcome as metadata only: `model-selected` with the model
ids, the chain step that produced them (`settings-override`, `title-agent`,
`session`, `assistant-message`, `catalog`) and the number of stale preferences,
plus a `title-agent-model-unavailable` event naming the stale ref. No prompt,
transcript or generated title is ever logged.

## Registration (V2 has no `tui.json`)

V2 TUI plugins are declared in the V2 config's `plugins` array
(`<config>/cli.json`), as strings or `{ package, options }` objects:

```json
{
  "plugins": [
    "/path/to/opencode-retitle/v2"
  ]
}
```

A directory target is resolved to `<dir>/tui` (`packages/tui/src/plugin/context.tsx:562-567`),
which `exports["./tui"] = "./tui.tsx"` in `v2/package.json` satisfies. The plugin
must be listed exactly once — listing the same directory twice would activate the
plugin twice.

## Public V2 API surface used

Pinned source: `/home/lkonga/codes/opencode-v2-scrollfix` (`c5f4ce3d66`).

| Need | Public API | Citation |
|---|---|---|
| Plugin module | `Plugin.define({ id, setup })` | `packages/plugin/src/tui/plugin.ts:7-14` |
| Plugin context | `Plugin.Context` | `packages/plugin/src/tui/context.ts:466-481` |
| Mount | `context.ui.slot({ append: "app", render })` | `packages/plugin/src/tui/context.ts:463`, `packages/tui/src/plugin/api.tsx:201-215` |
| Commands | `context.keymap.layer(() => KeymapLayer)` | `packages/tui/src/plugin/api.tsx:135-143`, `packages/tui/src/context/keymap.tsx:187-262` |
| Command shape | `{ id, title, description, group, bind, palette, slash, run }` | `packages/plugin/src/tui/context.ts:354-380` |
| Keybind | `bind` on the named command → one binding for its id | `packages/tui/src/context/keymap.tsx:187-262` |
| Slash args | `slash: { name: "retitle", arguments: true }` → `run(rawInput)` | `packages/tui/src/component/prompt/autocomplete.tsx:513-519`, `packages/tui/src/component/prompt/index.tsx:178-188,1115-1122` |
| Dialogs | `context.ui.dialog.select/prompt` | `packages/plugin/src/tui/context.ts:341-352`, `packages/tui/src/plugin/api.tsx:287-306` |
| Progress | `context.ui.dialog.show(render)` / `context.ui.dialog.clear()` | `packages/plugin/src/tui/context.ts:343,347`, `packages/tui/src/plugin/api.tsx:234-243` |
| Toasts | `context.ui.toast.show(...)` | `packages/plugin/src/tui/context.ts:244-253` |
| Route | `context.ui.router.current()` | `packages/plugin/src/tui/context.ts:438-442` |
| HTTP client | `context.client` | `packages/plugin/src/tui/context.ts:471` |
| Durable state | `context.storage.store(key, { initial })` | `packages/plugin/src/tui/context.ts:34-39`, `packages/tui/src/context/storage.tsx:44-70` |
| Reactive data | `context.data.location.{model,provider,agent}`, `context.data.session.{get,message}` | `packages/plugin/src/tui/context.ts:59-133` |
| Title refresh | `context.data.session.invalidate(sessionID)` then `context.data.session.sync(sessionID)` | `packages/plugin/src/tui/context.ts:77-78` |
| History | `client.message.list({ sessionID, limit, order })` | `packages/protocol/src/groups/message.ts:11-38` |
| Generation | `client.session.generate({ sessionID, prompt })` | `packages/protocol/src/groups/session.ts:613-629`, `packages/client/src/promise/generated/client.ts:841-849` |
| Helper | `client.session.create({ title, agent, model, location })` | `packages/server/src/handlers/session.ts:92-105`, `.../client.ts:465-480` |
| Title write | `client.session.rename({ sessionID, title })`, else `client.session.update({ sessionID, title })` | `.../client.ts:576-587` (pinned source); live OC2 `PATCH /api/session/{sessionID}`, operation id `session.update` |
| Cleanup | `client.session.remove({ sessionID })` | `.../client.ts:529-539` |

### Why the layer is `mode: "global"`

Both the command palette and the prompt's slash completion read the **reachable**
command view (`packages/tui/src/context/keymap.tsx:303-330`,
`packages/tui/src/component/command-palette.tsx:14-35`). Layer conditions are
matched before a command is reachable, and a plugin layer without an explicit
mode defaults to base (`packages/tui/src/context/keymap.tsx:213`) while the
prompt pushes the `autocomplete` mode whenever the slash menu is open
(`packages/tui/src/component/prompt/autocomplete.tsx:103`). A base-mode layer
would therefore vanish exactly when `/retitle` needs to be offered. A global
layer registers with no mode field and matches every mode.

No keybind is read from `cli.json`: the command's stroke is the fixed
`ctrl+shift+r` declared in `command.ts` and described under [Keybind](#keybind).
Because the runtime's keybind schema rejects unknown ids
(`packages/tui/src/config/keybind.ts`), adding `retitle.session.retitle` to the
config's `keybinds` is fatal rather than a remap — do not add one.

## Intentional differences from V1

| Area | V1 (`../tui.ts`) | V2 | Why |
|---|---|---|---|
| History window | every message the SDK returns | one page of ≤200, never cursor-walked | bounded prompt; a 10k-message session cannot blow up generation |
| Generation | `session.prompt` on a child session, then poll `session.messages` every 500 ms (24 attempts) | `session.generate` returns the text directly | no polling ⇒ no late/duplicate observations, and a hard deadline instead of a poll budget |
| Helper session | child of the current session (`parentID`) | short-lived top-level session, removed in `finally` | the public `session.create` payload has no `parentID` |
| Settings storage | `retitle-config.json` in `$OPENCODE_CONFIG_DIR || ~/.config/opencode` | host plugin storage (`context.storage`) | channel-scoped durable state; **no code path can reach the V1 config directory** |
| Model resolution | any unavailable pick was fatal (`Provider not available` / `Model not available`) | the explicit override is still fatal, but a stale `title` agent model is skipped and the chain continues | an inherited `agents.title.model` for a provider this runtime no longer has must not disable `/retitle`; the user's own choice stays fail-closed, and no model is ever hardcoded |
| Failure feedback | V1 logged `{key, message}` where the key embedded the error text | events and sizes only; errors become `{errorName, errorLength}` | never log provider text that may echo the transcript |
| `--samples/--offset/--from` | dialog only | dialog **and** the prompt line (`slash.arguments`) | the flags were documented but unreachable from the prompt |
| Keybind | none (palette/slash only) | fixed `ctrl+shift+r` on the same single command, not a config keybind | one reachable command that also owns a key stroke; adding a config keybind id for the plugin would be fatal (`Unrecognized keybind`), so the stroke is deliberately fixed and non-remappable (see [Keybind](#keybind)) |
| Busy modal | blocking dialog while generating | toasts + a non-blocking progress dialog + the run gate | the V2 dialog API is promise-based; a modal would have to be re-implemented |

## Tests

```bash
bun test v2/test            # behavioural unit/integration tests, no TUI runtime
```

Coverage highlights:

* `session-api.test.ts` — one bounded page, cursor never followed, tolerant
  envelopes, helper cleanup on success/failure/timeout, unbounded result bounds,
  no-polling failure when the runtime lacks `session.generate`, the dual title
  write (rename preferred, update fallback, no silent retry, AbortSignal on both,
  no direct `fetch`), and the bounded best-effort reactive refresh.
* `progress.test.ts` — the run-scoped progress lifecycle: idempotent clears, a
  stale handle can never dismiss a newer surface, a run only clears what it owns,
  a hostile/missing surface is contained, and `withProgress` clears on resolve,
  rejection and synchronous throw.
* `runner.test.ts` — empty / single-turn / 400-turn histories, `--offset`
  windowing, provider failure, deadline, model failure, refusal output, title
  cleaning, title write.
* `command-flow.test.ts` — one palette+slash registration, the fixed binding and
  its single-stroke uniqueness, raw-arg delivery, the bounded prompt going to the
  helper session only, the fallback model reaching a fresh `title`-agent helper
  when the configured title model is stale, concurrent invocation rejected (and
  it never clears the active run's progress), debounce window, Apply/Edit/Cancel/
  Regenerate, empty session, provider failure reopening settings, model
  persistence, gate release on a throwing dialog, generation/apply progress shown
  and cleared on every outcome, and the post-write session refresh.
* `adapter.test.ts` — durable settings round trip, store fallback with bounded
  slice, catalogue degradation, the full model chain (a stale `title` agent model
  skipped to the session, assistant and catalogue steps; the strict override
  failure retained; the unloaded-catalogue exception), model-source logging
  metadata, the write→refresh wiring (no refresh after a failed write, a failed
  refresh never failing a written title), toast debounce.
* `gate.test.ts`, `logger.test.ts` — run gate semantics and log redaction,
  including that the log path ignores the V1 config environment.
* `tui-contract.test.ts` — artifact-level guards: the resolved `./tui`
  entrypoint, the parsed V2 module graph (the runtime specifier is the only bare
  import, no module imports the V1 entrypoint, only `logger.ts` may open a file),
  no timer/listener/global in the progress path, and the byte-identical V1 files.
  Imports are read with `Bun.Transpiler.scan`, not by matching source text.

Runtime smokes on the V2 binary are recorded on issue #239.
