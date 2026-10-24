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

## [WIP] Continuous Semantic Retitling & Shadow Queue

Currently in active development on branch [`wt/v2-production/feat/continuous-retitle`](https://github.com/lkonga/opencode-retitle/tree/wt/v2-production/feat/continuous-retitle) (207 passing tests):

Continuous background session retitling transforms session naming from a manual action into an autonomous, non-intrusive background capability:

- **Semantic Topic-Drift Detection (`drift.ts`)**:
  - Monitors conversation turns in real-time as the user prompts.
  - Employs a tokenless lexical keyword coverage algorithm with noun stemming (`nounStem`) and stop-word filtering across sliding turn windows.
  - When sustained low topic coverage (<30% threshold over confirmed checks) indicates that the conversation has pivoted (e.g. from *frontend styling* to *docker networking*), it flags drift without spurious renames.
- **Shadow Mode & Title Candidate Queue (`shadow.ts`)**:
  - **Direct auto-apply mode**: Automatically renames the session in the background when drift or cadence triggers.
  - **Shadow queue mode**: Instead of mutating the session title directly, candidate titles are staged into a FIFO shadow queue (`title-candidates` in durable plugin storage).
  - Users can review queued suggestions on demand (`/retitle` -> *Review Queued Titles*), inspect before/after diffs (`Previous Title → Proposed Title`), edit, accept, or reject candidates.
- **Smart Manual Protection**:
  - Respects manual renames (`respectManualRename`): if a user explicitly renamed the session by hand, continuous retitling pauses automatically to prevent overwriting user intent.
- **Durable Turn Claims**:
  - Uses transactional claims (`claimEvaluation`) to guarantee background evaluations never double-run or race across turns.

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
