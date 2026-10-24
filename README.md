# opencode-retitle

TUI plugin for [OpenCode](https://opencode.ai) that adds a `/retitle` slash command to regenerate session titles from conversation history.

> **OpenCode V2 (OC2) Support:**  
> OpenCode V2 is supported on the **`v2-production`** branch (located in the `./v2` subdirectory).  
> It provides both interactive `/retitle` (`ctrl+shift+r`) and unattended `/retitle-auto` (with no pop-up dialogs and a `/btw`-style footer spinner). See [`v2/README.md`](./v2/README.md) for full V2 details and installation in `cli.json`.

Ported from the [VS Code Copilot Chat](https://github.com/microsoft/vscode-copilot-chat) fork's `/retitle` command.

## How it works

1. Samples recent conversation turns (tail-3 + spread sampling)
2. Sends sampled messages to the `"title"` agent via a helper child session
3. Polls for the generated title (60 attempts × 500ms)
4. Cleans the title (strips think tags, refusal detection, quote removal, max 100 chars)
5. Updates the current session title via `session.update`

## Usage

```
/retitle                                    # retitle from recent messages
/retitle → "deployment pipeline"            # with steering hint
/retitle → "--samples 20 --from 50"         # sample 20 turns from 50% point
/retitle → "--offset 30 --samples 15 docker setup"  # last 30 msgs, 15 samples, hint
```

### Flags

| Flag | Default | Range | Description |
|------|---------|-------|-------------|
| `--samples N` | 10 | 3–50 | Max user turns to sample |
| `--from P` | 100 | 0–100 | Percentage-based sampling center (100 = end) |
| `--offset N` | all | ≥1 | Use only last N messages (user + assistant) |

Any remaining text after flags is treated as a steering hint for the title.

## Installation

Add to your `tui.json` plugin array:

```json
{
  "plugin": [
    "file:///path/to/opencode-retitle"
  ]
}
```

Or install from npm (if published):

```json
{
  "plugin": [
    "opencode-retitle"
  ]
}
```

## Model selection

`/retitle` model resolution order:

1. Settings modal **Model** (saved in `retitle-config.json` under the OpenCode config dir)
2. `small_model` from `opencode.jsonc` (`provider/model`)
3. Last session message model
4. First available provider model

Open `/retitle` and use **Model:** in the settings modal (same pattern as `/execsa`).

## Requirements

- OpenCode v1.17.7+ (TUI plugin API with `keymap.registerLayer`)
- A configured `"title"` agent (built-in by default)
- At least one provider with a model

## License

MIT
