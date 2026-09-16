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
| `command.ts` | The single `/retitle` command (palette + slash in one registration) and the `mode: "global"` layer factory. |
| `dialogs.ts` | Lifecycle: run gate → settings dialog → run → confirm (Apply/Edit/Regenerate/Cancel) → apply. |
| `runner.ts` | Pure pipeline over injected ports: sample → model → native generation → clean title. |
| `adapter.ts` | The only module that knows `Plugin.Context`; wires context → ports, settings, gate, logger. |
| `session-api.ts` | Public client-method adapter: bounded history, helper lifecycle, native generation, rename. |
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
4. Resolve the title model (below) and fail fast if a configured model is not in
   the loaded catalogue.
5. Create a short-lived helper session pinned to the `title` agent and the
   resolved model, call the native `session.generate` under a 45 s deadline, and
   remove the helper in `finally` (separate 5 s deadline, failures are logged and
   swallowed).
6. Clean the result (think-tag stripping, quote removal, refusal detection,
   100-char cap) and offer Apply / Edit… / Regenerate / Cancel. Only Apply/Edit
   writes the title, through the public `session.rename`.

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

Remaining text after the flags is the steering hint.

### Title model resolution

1. settings override (chosen in the dialog, persisted as durable plugin state)
2. the built-in `title` agent's model — the V2 home of V1 `small_model`
   (`packages/core/src/config/normalize.ts:123-140`)
3. the session's current model
4. the first assistant message's model
5. the first enabled, non-deprecated catalogue model

A configured override is never silently replaced: if the catalogue is loaded and
does not contain it, the run fails with `Model from settings is not available in
this runtime: provider/model`.

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
| Command shape | `{ id, title, description, group, palette, slash, run }` | `packages/plugin/src/tui/context.ts:354-380` |
| Slash args | `slash: { name: "retitle", arguments: true }` → `run(rawInput)` | `packages/tui/src/component/prompt/autocomplete.tsx:513-519`, `packages/tui/src/component/prompt/index.tsx:178-188,1115-1122` |
| Dialogs | `context.ui.dialog.select/prompt` | `packages/plugin/src/tui/context.ts:341-352`, `packages/tui/src/plugin/api.tsx:287-306` |
| Toasts | `context.ui.toast.show(...)` | `packages/plugin/src/tui/context.ts:244-253` |
| Route | `context.ui.router.current()` | `packages/plugin/src/tui/context.ts:438-442` |
| HTTP client | `context.client` | `packages/plugin/src/tui/context.ts:471` |
| Durable state | `context.storage.store(key, { initial })` | `packages/plugin/src/tui/context.ts:34-39`, `packages/tui/src/context/storage.tsx:44-70` |
| Reactive data | `context.data.location.{model,provider,agent}`, `context.data.session.{get,message}` | `packages/plugin/src/tui/context.ts:59-133` |
| History | `client.message.list({ sessionID, limit, order })` | `packages/protocol/src/groups/message.ts:11-38` |
| Generation | `client.session.generate({ sessionID, prompt })` | `packages/protocol/src/groups/session.ts:613-629`, `packages/client/src/promise/generated/client.ts:841-849` |
| Helper | `client.session.create({ title, agent, model, location })` | `packages/server/src/handlers/session.ts:92-105`, `.../client.ts:465-480` |
| Rename | `client.session.rename({ sessionID, title })` | `.../client.ts:576-587` |
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

No keybind is invented: the command carries an `id` plus `palette`/`slash` and no
`bind`, matching the proven `opencode-pool-guard/v2` port. Unknown keybind ids in
`cli.json` are fatal (`packages/tui/src/config/keybind.ts`), so adding a binding
would require changing the canonical config.

## Intentional differences from V1

| Area | V1 (`../tui.ts`) | V2 | Why |
|---|---|---|---|
| History window | every message the SDK returns | one page of ≤200, never cursor-walked | bounded prompt; a 10k-message session cannot blow up generation |
| Generation | `session.prompt` on a child session, then poll `session.messages` every 500 ms (24 attempts) | `session.generate` returns the text directly | no polling ⇒ no late/duplicate observations, and a hard deadline instead of a poll budget |
| Helper session | child of the current session (`parentID`) | short-lived top-level session, removed in `finally` | the public `session.create` payload has no `parentID` |
| Settings storage | `retitle-config.json` in `$OPENCODE_CONFIG_DIR || ~/.config/opencode` | host plugin storage (`context.storage`) | channel-scoped durable state; **no code path can reach the V1 config directory** |
| Failure feedback | V1 logged `{key, message}` where the key embedded the error text | events and sizes only; errors become `{errorName, errorLength}` | never log provider text that may echo the transcript |
| `--samples/--offset/--from` | dialog only | dialog **and** the prompt line (`slash.arguments`) | the flags were documented but unreachable from the prompt |
| Busy modal | blocking dialog while generating | toasts + the run gate | the V2 dialog API is promise-based; a modal would have to be re-implemented |

## Tests

```bash
bun test v2/test            # behavioural unit/integration tests, no TUI runtime
```

Coverage highlights:

* `session-api.test.ts` — one bounded page, cursor never followed, tolerant
  envelopes, helper cleanup on success/failure/timeout, unbounded result bounds,
  no-polling failure when the runtime lacks `session.generate`, rename wiring.
* `runner.test.ts` — empty / single-turn / 400-turn histories, `--offset`
  windowing, provider failure, deadline, model failure, refusal output, title
  cleaning, title write.
* `command-flow.test.ts` — one palette+slash registration, raw-arg delivery,
  concurrent invocation rejected, debounce window, Apply/Edit/Cancel/Regenerate,
  empty session, provider failure reopening settings, model persistence, gate
  release on a throwing dialog.
* `adapter.test.ts` — durable settings round trip, store fallback with bounded
  slice, catalogue degradation, model resolution order and validation, toast
  debounce.
* `gate.test.ts`, `logger.test.ts`, `tui-contract.test.ts` — run gate semantics,
  log redaction, and the public-boundary / V1-byte-identity guards.

Runtime smokes on the V2 binary are recorded on issue #239.
