# opencode-retitle

TUI plugin for [OpenCode](https://opencode.ai) that adds `/retitle` and `/retitle-auto` slash commands to regenerate session titles from conversation history.

Designed for **OpenCode V2 (OC2)** as a first-class citizen (located in `./v2`), with legacy support for OpenCode V1 at the repository root.

---

## OpenCode V2 (OC2) — Primary

OpenCode V2 implementation lives in `./v2`.

### Features
- **`/retitle`** (`ctrl+shift+r`): Interactive retitle with sampling controls, model override selection, and interactive confirmation menus (`(Y/n)` apply confirmation and `(y/N)` cancel protection).
- **`/retitle-auto`**: Unattended execution using current settings. Instantly generates and applies the new title with **no pop-up modals or user attention required**.
- **Non-blocking footer spinner**: Shows animated status indicator in `prompt.footer.status` during generation.
- **Fail-safe concurrency**: Run-gate concurrency guarantees exactly one generation in flight at a time.
- **Durable settings**: Persisted via the host's V2 plugin storage (never touches V1 config paths).

### Usage (V2)

```text
/retitle                                    # interactive retitle from recent turns
/retitle deployment pipeline                # interactive with steering hint
/retitle --samples 20 --from 50             # sample 20 turns from the 50% point
/retitle --offset 30 --samples 15 docker    # last 30 msgs, 15 samples, hint
/retitle-auto                               # unattended: auto-applies title without dialogs
/retitle-auto quick fix                     # unattended with steering hint
```

### Installation (V2)

Add to your `cli.json` plugin array:

```json
{
  "plugin": [
    "file:///path/to/opencode-retitle/v2"
  ]
}
```

See [`v2/README.md`](./v2/README.md) for architecture details, public API audit, and test documentation.

---

## OpenCode V1 (Legacy)

The repository root contains the legacy V1 plugin for OpenCode v1.17.7+.

### How it works (V1)

1. Samples recent conversation turns (tail-3 + spread sampling)
2. Sends sampled messages to the `"title"` agent via a helper child session
3. Polls for the generated title (60 attempts × 500ms)
4. Cleans the title (strips think tags, refusal detection, quote removal, max 100 chars)
5. Updates the current session title via `session.update`

### Usage (V1)

```text
/retitle                                    # retitle from recent messages
/retitle → "deployment pipeline"            # with steering hint
/retitle → "--samples 20 --from 50"         # sample 20 turns from 50% point
/retitle → "--offset 30 --samples 15 docker setup"  # last 30 msgs, 15 samples, hint
```

### Installation (V1)

Add to your `tui.json` plugin array:

```json
{
  "plugin": [
    "file:///path/to/opencode-retitle"
  ]
}
```

### Model selection (V1)

`/retitle` model resolution order:
1. Settings modal **Model** (saved in `retitle-config.json` under the OpenCode config dir)
2. `small_model` from `opencode.jsonc` (`provider/model`)
3. Last session message model
4. First available provider model

---

## License

MIT
