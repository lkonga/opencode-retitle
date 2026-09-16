# Native title audit (OpenCode V2)

What the V2 runtime already does with session titles, what it does **not** do, and
which of it `/retitle` reuses. Everything below is read from two read-only
sources, both consulted for this port:

| Source | Identity |
|---|---|
| Pinned public source | `/home/lkonga/codes/opencode-v2-scrollfix` @ `c5f4ce3d66` |
| Installed runtime | `~/.opencode/bin/opencode-v2`, `opencode2 v2.0.3-dev-patched-e3ee3d3cb1`; live spec `GET http://127.0.0.1:49375/openapi.json` (read 2026-09-16) |

The two are different revisions of the same tree. Where they disagree, the
disagreement is called out — it is the reason the plugin only ever calls
generated client methods and never builds a request itself.

## 1. Automatic titling exists, and only ever fires once, for a root session

`SessionTitle` (`packages/core/src/session/title.ts`) exposes exactly one
operation:

```ts
export interface Interface {
  /** Generates a title from the session's first user message when the session remains untitled. */
  readonly generateForFirstPrompt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}
```

Its guards make the scope explicit:

| Guard | Location | Effect |
|---|---|---|
| `if (session.parentID) return` | `title.ts:59` | child sessions are never auto-titled |
| `if (!isUntitled(session)) return` | `title.ts:60` | fires only while the title is still the exact root fallback |
| `if (!firstUser) return` | `title.ts:61-62` | requires a first user message |
| `agents.get(Agent.ID.make("title"))` | `title.ts:63` | uses the built-in `title` agent, or nothing |
| `agent.model ?? session model` | `title.ts:65-69` | prefers the title agent's model (where V1 `small_model` migrates) |

"Still untitled" is exact, not approximate — `isUntitled` delegates to
`isExactRootFallback` (`packages/util/src/session-title-fallback.ts`), which
matches a missing title or the literal `New session - <ISO timestamp>` value
derived from `time.created`. Anything else (including a previous `/retitle`)
means the automatic path no longer applies.

The prompt is the **first user message only**: `messages: [Message.user(firstUser.text)]`
with `system: agent.system` (`title.ts:83-91`). Output is the first non-empty
line, truncated to 100 characters (`title.ts:23,116-121`), published as
`SessionEvent.Renamed` with a compare-and-set on the bus sequence
(`title.ts:122-134`).

The single call site is the runner, after a successful step
(`packages/core/src/session/runner/llm.ts:610-622`), and it is wrapped in a
per-session `titlesRunning` set — at most one title request per session, ever:

```ts
/** Starts one title request at a time after a successful step makes user input visible. */
const startTitle = Effect.fnUntraced(function* (sessionID) {
  if (titlesRunning.has(sessionID)) return
  ...
})
```

### Consequences for /retitle

* A session that already has a title (from auto-titling or a previous
  `/retitle`) will **not** be re-titled by the runtime. Re-generating a title on
  demand is exactly the gap this plugin fills.
* The runtime's auto-title is not a hook the plugin can call: `SessionTitle` is a
  location-scoped core service with no HTTP surface (next section).

## 2. There is no on-demand retitle API

Checked against both sources:

* `SessionTitle.Interface` (`title.ts:38-41`) declares only
  `generateForFirstPrompt`. It is never wired into a server handler.
* The protocol groups contain no title endpoint: `grep -rn "title"
  packages/protocol/src/groups/*.ts` matches nothing routable, and the live
  OpenAPI document has no path containing `title`.
* The only title-shaped public write is the rename route, whose operation id is
  `session.rename` (see the divergence table below).

So `/retitle` must compose **generation + rename** itself. It cannot ask the
runtime to "retitle this session".

## 3. Public generation surfaces, and which one /retitle uses

| Surface | Shape | Verdict |
|---|---|---|
| `client.session.generate({ sessionID, prompt })` → `{ text }` | `POST /api/session/:sessionID/generate`; `packages/protocol/src/groups/session.ts:613-629`; handler `packages/server/src/handlers/session.ts:742-757`; client `packages/client/src/promise/generated/client.ts:841-849` | **Used.** Description: *"Generate transient text from the current session context without mutating session history."* Needs a session, so the plugin creates one short-lived helper pinned to the `title` agent and the resolved model. |
| `client.generate.text({ prompt, model?, location? })` → `{ text }` | `POST /api/generate`; `packages/protocol/src/groups/generate.ts:10-20`; client `.../client.ts:941-953` | **Not used.** It is a stateless one-shot: no session means no `title` agent system prompt and no session-scoped model headers, so it would diverge from both V1 and the native auto-titler. It also takes its location from the request rather than from a session row. |
| `client.session.prompt(...)` + polling `client.message.list(...)` | V1's flow (`../tui.ts:456-466`) | **Not used.** It is the only path that needs polling, and polling is where duplicate/late observations come from. |

Why the helper session gives the native behaviour:

* `session.create({ agent: "title", model, location })` persists `agent`/`model`
  on the session (`packages/schema/src/session.ts:28-49`; handler
  `packages/server/src/handlers/session.ts:92-105`).
* `session.generate` resolves the session context and builds the request with
  `selection.agent.info.system` (`packages/core/src/session/generate-node.ts`),
  i.e. the built-in title agent's system prompt
  (`packages/core/src/plugin/agent.ts:151-157`, `PROMPT_TITLE` at `:36`), which
  is what constrains output to a single line of at most ~50 characters.
* Session-scoped routes resolve their location from the session row
  (`packages/server/src/middleware/session-location.ts`), so the helper is
  created with the current location and `session.generate`'s internal
  `session.location.directory === location.directory` check
  (`packages/core/src/session/context.ts`) holds instead of interrupting.
* The endpoint is synchronous from the client's perspective: the handler returns
  `{ data: { text } }`, so there is no window in which a second run could observe
  the first run's helper.

## 4. Wire-shape divergence (why nothing is hand-rolled)

| Operation | Client method | Pinned source | Installed runtime |
|---|---|---|---|
| Rename | `session.rename({ sessionID, title })` | `POST /api/session/:sessionID/rename`, 204 (`packages/protocol/src/groups/session.ts`) | `PATCH /api/session/:sessionID`, operation id `session.rename`, body `{ title }` |
| Generate | `session.generate({ sessionID, prompt })` | `POST …/generate` → `{ data: { text } }`, client unwraps to `{ text }` | same path, `SessionGenerateResponse` = `{ data: { text } }` |
| Messages | `message.list({ sessionID, limit, order })` | `GET …/message` → `{ data, cursor }`, `limit` ≤ 200 | same path; adds a `type` filter; `limit` declared without a cap |
| Model info | `data.location.model.list()` | `Model.Info.id` **and** `modelID` are distinct (`packages/schema/src/model.ts:90-112`); `Model.Ref.id` is matched against `Model.Info.id` (`packages/core/src/session/runner/model.ts:82`) | `Model.Info` carries both fields |

The plugin therefore:

* calls client methods only (`session-api.ts`), and
* normalizes results tolerantly (`normalizeGeneratedText`,
  `normalizeMessagePage`, `normalizeCreatedSessionID` in `retitle-core.ts`), so a
  revision drift degrades to "no title" instead of a wrong write.

## 5. Auto-title vs `/retitle`

| | Automatic (native) | `/retitle` (this plugin) |
|---|---|---|
| Trigger | first successful prompt step | explicit command (slash or palette) |
| Scope | root sessions only; only while still exactly untitled | any session, any number of times |
| History | first user message only | bounded page (200 messages), tail-3 + spread sampling |
| Model | `title` agent model, else the session model (a stale agent model is used, and fails at request time) | settings override (strict) → `title` agent model **only when the loaded catalogue carries it** → session model → first assistant model → first catalogue model |
| Write | `SessionEvent.Renamed` (100-char cap, CAS on bus sequence) | `session.rename` after explicit Apply/Edit |
| Config | `agents.title.model` (`small_model` migrated at `packages/core/src/config/normalize.ts:123-140`) | own durable plugin state; `small_model` equivalent still read from the title agent |

## 6. Verification against the installed runtime (2026-09-16)

Read live from the running instance (`opencode-v2 serve --service`, port 49375)
rather than from source: `GET /openapi.json`, then `GET /api/agent`,
`GET /api/model` and `GET /api/provider`, cross-checked against the V2 config
file (`<config>/opencode.jsonc`) and the live `cli.json`. The point of this
section is that every public surface `/retitle` uses was checked against the
binary that actually serves it.

| Check | Result |
|---|---|
| `session.generate` | `POST /api/session/{sessionID}/generate`, body `{ prompt }` only (the session is the path parameter), response `{ data: { text } }`. The plugin's `{ sessionID, prompt }` client call and its `text` / `data.text` reader both match. |
| `session.rename` / `session.remove` | `PATCH` and `DELETE` on `/api/session/{sessionID}`, operation ids `session.rename` / `session.remove`. There is no `/rename` path in the installed spec — the divergence in §4 is real and is exactly why the plugin never builds a request. |
| `session.create` | Body `{ id?, title?, agent?, model?, location? }`; `model` is `Model.Ref { id, providerID, variant? }`, `location` is `Location.PublicRef { directory }`. The plugin sends exactly `{ title, agent, model, location }`. Excess properties are tolerated, not rejected — a bogus query parameter on `agent.list` still returns 200 — so a location that also carries `workspaceID` cannot break the helper create. |
| `message.list` | Accepts `limit`, `order` (`asc`/`desc`), `cursor` and a `type` filter. `/retitle` sends one page, `limit=200&order=desc`, and never follows `cursor`. |
| `Agent.Info.model` | `Model.Ref` (`id`, `providerID`, optional `variant`), optional on the agent. The live `agent.list` returns 68 agents including the hidden `title` agent, whose model is the configured `agents.title.model`. This is the value `models.ts` reads, prefers when the loaded catalogue carries it, and otherwise skips down the chain — there is no hardcoded model anywhere in the plugin. |
| `Model.Info.id` vs `modelID` | `Model.Info` carries both and they are **not** interchangeable: 8 of 224 live entries differ (`om-dsv4f`/`dsv4f`, `*-fast`). Refs (`Model.Ref`, `session.create`, `session.switchModel`) match on `id`, which is what the plugin's resolver, catalogue match and model picker all use. Normalizing to `modelID` would break those entries. |
| Native duplicate | The installed binary contains no `retitle` string at all, and the pinned source has no routable title endpoint: there is no native command, route or palette entry for `/retitle` to collide with. |
| Keybind conflicts | `ctrl+shift+r` appears in none of the 218 TUI defaults (`packages/tui/src/config/keybind.ts` @ `c5f4ce3d66`) and in no `keybinds` override of the live `cli.json`. The single `mod+shift+r` in the tree is `review.toggle` in `packages/app`, a separate non-TUI surface. |

### Deployment note (config parity vs. plugin usability)

On this host the live config sets `agents.title.model` to
`9router/9r-xai-grok-4.5-low` (inherited from V1), while the running instance
advertises providers `github-copilot`, `merge-gateway`, `deepseek`,
`codex-omniroute`, `omniroute` and lists no `9router` model.

`/retitle` treats that as a stale *preference*: the title agent's model is
skipped (logged as `title-agent-model-unavailable` with the ref, metadata only),
the chain continues to the session model / assistant model / first catalogue
model, and the chosen fallback is pinned to the fresh `title`-agent helper. An
explicit **settings** override for an unavailable model still fails closed, and
nothing is hardcoded, so the plugin stays usable without touching the canonical
title config or its parity.

The native auto-titler is not affected by this decision and keeps using
`agent.model ?? session model` (`packages/core/src/session/title.ts:65-69`), so a
stale `agents.title.model` still degrades automatic titling — fixing the config
is worthwhile for that reason, not for `/retitle`.

The plugin is also not currently listed in the live `cli.json` `plugins` array,
so the V2 TUI does not load it yet. Registration there is one entry, never two
(listing the same directory twice would register the keymap layer twice).
