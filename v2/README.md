# opencode-retitle — V2 port

V2 TUI implementation of `/retitle` (issue
[#226](https://github.com/lkonga/opencode-patches/issues/226)).

The V1 entrypoint (`../tui.ts`, exported as `./tui` from the repo root
`package.json`) is **untouched** and keeps loading under the V1 runtime. This
directory only adds the V2 implementation.

## Files

| File | Purpose |
|---|---|
| `tui.tsx` | V2 TUI plugin entry (`Plugin.define({ id, setup })`). |
| `retitle-core.ts` | Pure logic: arg parsing, sampling, title prompt, title cleaning, model resolution. No runtime imports, unit-testable. |
| `config.ts` | Persisted `retitle-config.json` (model override), atomic + 0600. |
| `test/retitle-core.test.ts` | Focused unit tests (`bun test`). |

## Registration (V2 has no `tui.json`)

V2 TUI plugins are declared in `cli.json`'s `plugins` array
(`packages/tui/src/config/index.tsx:57`, read from
`<config>/cli.json` at `packages/cli/src/config/config.ts:31`, consumed at
`packages/tui/src/plugin/context.tsx:233`). Entries may be strings or
`{ package, options }`; local paths are resolved by
`packages/tui/src/plugin/discovery.ts:41` (`localSource`) and
`packages/tui/src/plugin/context.tsx:562` (`resolveLocal`).

```json
{
  "plugins": [
    "/home/lkonga/codes/opencode-plugins/opencode-retitle/.worktrees/retitle/v2"
  ]
}
```

Register it with the sanctioned helper (runs the mandatory backup gate and
serializes writers with `flock`):

```bash
scripts/v2-register-plugin.sh \
  --tui /home/lkonga/codes/opencode-plugins/opencode-retitle/.worktrees/retitle/v2 \
  --label issue-226
```

## Public V2 API surface used (pinned source `/home/lkonga/codes/opencode-v2-scrollfix`)

| Need | Public API | Citation |
|---|---|---|
| Plugin module | `Plugin.define({ id, setup })` | `packages/plugin/src/tui/plugin.ts:7,12` |
| Plugin context | `Plugin.Context` | `packages/plugin/src/tui/context.ts:466` |
| Mount a component | `context.ui.slot({ append: "app", render })` | `packages/plugin/src/tui/context.ts:463` |
| Register commands | `context.keymap.layer(() => KeymapLayer)` with `mode: "global"` | `packages/plugin/src/tui/context.ts:382-395,412` |
| Command shape | `{ id, title, description, group, palette, slash, run }` | `packages/plugin/src/tui/context.ts:354-380` |
| Slash + raw args | `slash: { name: "retitle", arguments: true }` | `packages/plugin/src/tui/context.ts:370-375` |
| Dialogs | `context.ui.dialog.select/prompt` | `packages/plugin/src/tui/context.ts:350-351` |
| Toasts | `context.ui.toast.show(...)` | `packages/plugin/src/tui/context.ts:252` |
| Current route | `context.ui.router.current()` | `packages/plugin/src/tui/context.ts:441` |
| HTTP client | `context.client` | `packages/plugin/src/tui/context.ts:471` |
| Reactive data | `context.data.location.{agent,model,provider}`, `context.data.session.get/message` | `packages/plugin/src/tui/context.ts:67,80,122,129,130` |
| Session messages | `client.message.list({ sessionID, limit, order })` | `packages/client/src/promise/generated/client.ts:901` |
| Transient generation | `client.session.generate({ sessionID, prompt })` | `packages/client/src/promise/generated/client.ts:841` (`packages/core/src/session/generate.ts:14`) |
| Helper session | `client.session.create({ title, agent, model, location })` | `packages/client/src/promise/generated/client.ts:465` |
| Apply title | `client.session.rename({ sessionID, title })` | `packages/client/src/promise/generated/client.ts:576` |
| Delete helper | `client.session.remove({ sessionID })` | `packages/client/src/promise/generated/client.ts:529` |

Reference for the slot + keymap-layer mounting pattern:
`packages/tui/src/feature-plugins/system/plugins.tsx:136-158`.

### Keybinds

No keybind is invented. Unknown **keybind config** ids are fatal
(`packages/tui/src/config/keybind.ts:316`, `Unrecognized keybind...`), so the
command carries only a command `id` plus `palette`/`slash` and no `bind` — the
same shape as the proven `opencode-pool-guard/v2` and `opencode-execsa/v2`
ports. The layer is global because prompt slash completion and the command
palette cannot reach a base-mode layer (`packages/tui/src/context/keymap.tsx`).

## Behaviour mapping (V1 → V2)

| V1 | V2 |
|---|---|
| `api.keymap.registerLayer({ commands })` | `context.keymap.layer(() => ({ commands }))` |
| `namespace/name/desc/category/slashName` | `id/description/group/slash` |
| `api.route.current.name === "session"` + `params.sessionID` | `context.ui.router.current().type === "session"` + `.sessionID` |
| `api.ui.dialog.replace(() => DialogSelect({ onSelect }))` | `await context.ui.dialog.select({ ... })` |
| `api.ui.toast({ ... })` | `context.ui.toast.show({ ... })` |
| `client.session.messages({ sessionID })` (V1 SDK) | `client.message.list({ sessionID, order: "desc" })`, reversed |
| `client.session.update({ sessionID, title })` | `client.session.rename({ sessionID, title })` |
| `client.session.delete({ sessionID })` | `client.session.remove({ sessionID })` |
| helper child session + `agent: "title"` prompt + poll | helper session created with `agent: "title"` + model, then `session.generate` returns the text directly (prompt+poll fallback if `session.generate` is absent) |
| `small_model` config | V2 migrates `small_model` to `agents.title.model` (`packages/core/src/config/normalize.ts:123-140`); read from `data.location.agent.list()` → `title` agent (built-in at `packages/core/src/plugin/agent.ts:151`) |
| `api.state.provider` model list | `context.data.location.model.list()` / `provider.list()` |

Model resolution order is unchanged: settings override → title agent model
(V1 `small_model`) → session model → first assistant message model → first
enabled, non-deprecated catalog model. Model list, sampling (tail-3 + spread),
`--samples/--offset/--from` parsing, the title prompt, title cleaning and the
Apply / Edit / Regenerate / Cancel confirm flow are ported 1:1.

### Intentional differences

- **Busy modal**: V1 blocked input with a busy `DialogPrompt` while generating.
  The V2 plugin does not render a modal (the dialog API is promise-based); the
  in-flight guard still prevents concurrent runs and failures surface as toasts.
- **Helper session parent**: V1 created the helper with `parentID`. V2's public
  `session.create` payload has no `parentID`
  (`packages/client/src/promise/generated/client.ts:465`), so the helper is a
  short-lived top-level session that is removed in a `finally` block.
- **Extra capability**: `slash.arguments: true` keeps raw `/retitle ...` input
  and seeds the settings dialog, so the documented `--samples/--offset/--from`
  flags now work from the prompt line (V1 accepted them only via the dialog).

## Tests

```bash
bun test v2/test            # focused unit tests, no runtime needed
```

Runtime smokes (V2 binary, protected tmux sessions) are recorded on issue #226.
