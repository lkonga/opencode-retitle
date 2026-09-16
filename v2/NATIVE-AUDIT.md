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
| Model | `title` agent model, else the session model | settings override → `title` agent model → session model → last assistant model → first catalogue model |
| Write | `SessionEvent.Renamed` (100-char cap, CAS on bus sequence) | `session.rename` after explicit Apply/Edit |
| Config | `agents.title.model` (`small_model` migrated at `packages/core/src/config/normalize.ts:123-140`) | own durable plugin state; `small_model` equivalent still read from the title agent |
