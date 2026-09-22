// Behavioural tests for the public session API adapter: the request shapes it
// sends, the bounded history it reads, and the lifecycle guarantees around the
// generation helper session.

import { describe, expect, test } from "bun:test"
import {
  applySessionTitle,
  generateTitleText,
  loadSessionMessages,
  refreshSessionTitle,
  selectTitleWrite,
  supportsNativeGeneration,
  MESSAGE_PAGE_LIMIT,
} from "../session-api"
import { RetitleTimeoutError } from "../deadline"
import { RetitleError } from "../errors"
import { MAX_GENERATED_TEXT_LENGTH } from "../retitle-core"
import type { RetitleLogger, LogFields } from "../logger"
import { fakeClient, never, userMessage, assistantMessage } from "./fake"

function captureLogger() {
  const lines: Array<Record<string, unknown>> = []
  const events: Array<{ name: string; fields: LogFields }> = []
  const logger: RetitleLogger = {
    event(name, fields = {}) {
      events.push({ name, fields })
      lines.push({ event: name, ...fields })
    },
  }
  return { logger, events, lines, text: () => JSON.stringify(lines) }
}

describe("loadSessionMessages", () => {
  test("requests one bounded newest-first page and restores ascending order", async () => {
    const { client, calls } = fakeClient({
      list: () => ({
        data: [assistantMessage("new answer"), userMessage("new question"), assistantMessage("old answer"), userMessage("old question")],
        cursor: { next: "ignored" },
      }),
    })

    const messages = await loadSessionMessages(client, "ses_1")

    expect(calls.lists).toHaveLength(1)
    expect(calls.lists[0]).toEqual({ sessionID: "ses_1", limit: MESSAGE_PAGE_LIMIT, order: "desc" })
    expect(messages.map((message) => message.text)).toEqual([
      "old question",
      "old answer",
      "new question",
      "new answer",
    ])
  })

  test("never follows the pagination cursor, so history stays bounded", async () => {
    let calls = 0
    const { client } = fakeClient({
      list: () => {
        calls += 1
        return { data: [userMessage(`turn ${calls}`)], cursor: { next: "page-2" } }
      },
    })

    await loadSessionMessages(client, "ses_1")

    expect(calls).toBe(1)
  })

  test("tolerates an unwrapped array and rejects malformed pages", async () => {
    const bare = fakeClient({ list: () => [userMessage("hello")] })
    expect((await loadSessionMessages(bare.client, "ses_1")).map((m) => m.text)).toEqual(["hello"])

    const malformed = fakeClient({ list: () => ({ nope: true }) })
    const { logger, events } = captureLogger()
    expect(await loadSessionMessages(malformed.client, "ses_1", { logger })).toEqual([])
    expect(events.map((event) => event.name)).toEqual(["history-loaded"])
  })

  test("logs a redaction-safe failure and degrades to empty instead of throwing", async () => {
    const { client } = fakeClient({
      list: () => {
        throw new Error("transport exploded: SESSION-TRANSCRIPT-MARKER")
      },
    })
    const { logger, text } = captureLogger()

    const messages = await loadSessionMessages(client, "ses_1", { logger })

    expect(messages).toEqual([])
    expect(text()).toContain("history-error")
    expect(text()).not.toContain("SESSION-TRANSCRIPT-MARKER")
  })
})

describe("generateTitleText", () => {
  const input = {
    model: { id: "gpt-5", providerID: "openai" },
    prompt: "summarise",
    location: { directory: "/workspace/app" },
  }

  test("creates a title-agent helper, generates once, and removes the helper", async () => {
    const { client, calls } = fakeClient({ create: () => ({ id: "ses_helper" }) })

    const text = await generateTitleText({ client, ...input })

    expect(text).toBe("Generated title")
    expect(calls.creates).toEqual([
      {
        title: "Retitle generation",
        agent: "title",
        model: { id: "gpt-5", providerID: "openai" },
        location: { directory: "/workspace/app" },
      },
    ])
    expect(calls.generates).toEqual([{ sessionID: "ses_helper", prompt: "summarise" }])
    expect(calls.removes).toEqual(["ses_helper"])
  })

  test("removes the helper when generation fails and surfaces a typed error", async () => {
    const { client, calls } = fakeClient({
      generate: () => {
        throw new Error("provider 502")
      },
    })
    const { logger, text } = captureLogger()

    await expect(generateTitleText({ client, ...input, logger })).rejects.toBeInstanceOf(RetitleError)

    expect(calls.removes).toEqual(["ses_helper"])
    expect(text()).toContain("generate-error")
    expect(text()).not.toContain("summarise")
  })

  test("enforces a hard timeout and still removes the helper", async () => {
    const { client, calls } = fakeClient({ generate: () => never() })
    const { logger, events } = captureLogger()

    const failure = generateTitleText({ client, ...input, logger, generateTimeoutMs: 20 }).catch((error) => error)

    const error = await failure
    expect(error).toBeInstanceOf(RetitleTimeoutError)
    expect((error as RetitleTimeoutError).stage).toBe("generate")
    expect(calls.removes).toEqual(["ses_helper"])
    expect(events.some((event) => event.name === "helper-removed")).toBe(true)
  })

  test("a failing cleanup never replaces the generation result", async () => {
    const { client } = fakeClient({
      remove: () => {
        throw new Error("cleanup refused")
      },
    })

    expect(await generateTitleText({ client, ...input })).toBe("Generated title")
  })

  test("normalizes a malformed or empty result to undefined", async () => {
    for (const value of [undefined, null, { text: 42 }, { data: { text: 7 } }, { text: "   " }, "   "]) {
      const { client } = fakeClient({ generate: () => value })
      expect(await generateTitleText({ client, ...input })).toBeUndefined()
    }
  })

  test("accepts both known response envelopes", async () => {
    const unwrapped = fakeClient({ generate: () => ({ text: "unwrapped title" }) })
    expect(await generateTitleText({ client: unwrapped.client, ...input })).toBe("unwrapped title")

    const wrapped = fakeClient({ generate: () => ({ data: { text: "wrapped title" } }) })
    expect(await generateTitleText({ client: wrapped.client, ...input })).toBe("wrapped title")

    const bare = fakeClient({ generate: () => "bare title" })
    expect(await generateTitleText({ client: bare.client, ...input })).toBe("bare title")
  })

  test("bounds an unbounded generation result and records the truncation", async () => {
    const { client } = fakeClient({ generate: () => ({ text: "x".repeat(100_000) }) })
    const { logger, events, text } = captureLogger()

    const result = await generateTitleText({ client, ...input, logger })

    expect(result?.length).toBe(MAX_GENERATED_TEXT_LENGTH)
    const truncated = events.find((event) => event.name === "generate-truncated")
    expect(truncated?.fields.rawLength).toBe(100_000)
    expect(text()).toContain("generate-truncated")
  })

  test("enforces a hard timeout on helper creation", async () => {
    const { client, calls } = fakeClient({ create: () => never() })
    const { logger, events } = captureLogger()

    await expect(generateTitleText({ client, ...input, logger, helperTimeoutMs: 20 })).rejects.toMatchObject({
      code: "helper-create",
    })

    expect(events.some((event) => event.name === "helper-create-error")).toBe(true)
    expect(events.some((event) => event.fields.timedOut === true)).toBe(true)
    // Nothing was created, so there is nothing to clean up and no prompt was sent.
    expect(calls.generates).toEqual([])
    expect(calls.removes).toEqual([])
  })

  test("a hanging cleanup cannot hang the run", async () => {
    const { client, calls } = fakeClient({ remove: () => never() })
    const { logger, events } = captureLogger()

    expect(await generateTitleText({ client, ...input, logger, cleanupTimeoutMs: 20 })).toBe("Generated title")

    expect(calls.removes).toEqual(["ses_helper"])
    const failed = events.find((event) => event.name === "helper-remove-error")
    expect(failed?.fields.timedOut).toBe(true)
  })

  test("fails fast instead of polling when the runtime has no native generation", async () => {
    const { client, calls } = fakeClient({ withoutGenerate: true })
    const { logger, events } = captureLogger()

    expect(supportsNativeGeneration(client)).toBe(false)
    await expect(generateTitleText({ client, ...input, logger })).rejects.toMatchObject({ code: "unsupported" })

    // No helper, no prompt, no polling: nothing was attempted.
    expect(calls.creates).toEqual([])
    expect(calls.generates).toEqual([])
    expect(calls.lists).toEqual([])
    expect(events).toEqual([])
  })

  test("reports a helper that the server refuses to create", async () => {
    const { client, calls } = fakeClient({ create: () => ({ nope: true }) })

    await expect(generateTitleText({ client, ...input })).rejects.toMatchObject({ code: "helper-create" })
    expect(calls.removes).toEqual([])
  })
})

describe("applySessionTitle", () => {
  test("writes the title through the public rename method", async () => {
    const { client, calls } = fakeClient()
    await applySessionTitle(client, "ses_1", "Deployment pipeline")
    expect(calls.renames).toEqual([{ sessionID: "ses_1", title: "Deployment pipeline" }])
  })

  test("maps a rename failure to a typed error without leaking provider text", async () => {
    const { client } = fakeClient({
      rename: () => {
        throw new Error("rename rejected: SESSION-TRANSCRIPT-MARKER")
      },
    })
    const { logger, text } = captureLogger()

    await expect(applySessionTitle(client, "ses_1", "x", { logger })).rejects.toMatchObject({ code: "rename" })
    expect(text()).not.toContain("SESSION-TRANSCRIPT-MARKER")
  })

  test("reports a runtime without rename support", async () => {
    const client = { session: {}, message: {} } as never
    await expect(applySessionTitle(client, "ses_1", "x")).rejects.toMatchObject({ code: "unsupported" })
  })

  test("prefers the pinned rename contract and carries a request AbortSignal", async () => {
    const { client, calls } = fakeClient()
    const { logger, events } = captureLogger()

    await applySessionTitle(client, "ses_1", "Deployment pipeline", { logger })

    expect(calls.renames).toEqual([{ sessionID: "ses_1", title: "Deployment pipeline" }])
    expect(calls.updates).toEqual([])
    expect(calls.renameOptions).toHaveLength(1)
    expect(calls.renameOptions[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(calls.renameOptions[0]?.signal?.aborted).toBe(false)
    expect(events.find((event) => event.name === "title-updated")?.fields).toMatchObject({
      sessionID: "ses_1",
      operation: "rename",
      titleLength: "Deployment pipeline".length,
    })
  })

  test("falls back to the live update contract when the runtime has no rename", async () => {
    const { client, calls } = fakeClient({ withoutRename: true })
    const { logger, events } = captureLogger()

    await applySessionTitle(client, "ses_1", "Live contract", { logger })

    expect(calls.updates).toEqual([{ sessionID: "ses_1", title: "Live contract" }])
    expect(calls.renames).toEqual([])
    expect(calls.updateOptions).toHaveLength(1)
    expect(calls.updateOptions[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(events.find((event) => event.name === "title-updated")?.fields).toMatchObject({ operation: "update" })
  })

  test("selects by availability, never by outcome", async () => {
    const { client, calls } = fakeClient({
      rename: () => {
        throw new Error("rename rejected")
      },
    })

    await expect(applySessionTitle(client, "ses_1", "x")).rejects.toMatchObject({ code: "rename" })
    // A failed rename is a failed write: no second attempt through `update`.
    expect(calls.updates).toEqual([])
  })

  test("names the selected operation in the error without leaking the title", async () => {
    const { client } = fakeClient({
      withoutRename: true,
      update: () => {
        throw new Error("update rejected: SESSION-TRANSCRIPT-MARKER")
      },
    })
    const { logger, events, text } = captureLogger()

    const failure = (await applySessionTitle(client, "ses_1", "SECRET-TITLE", { logger }).catch((error) => error)) as Error

    expect(events.find((event) => event.name === "title-update-error")?.fields).toMatchObject({ operation: "update" })
    expect(failure.message).toContain("session.update")
    expect(failure.message).not.toContain("SECRET-TITLE")
    expect(text()).not.toContain("SESSION-TRANSCRIPT-MARKER")
    expect(text()).not.toContain("SECRET-TITLE")
  })

  test("bounds the write with a deadline that names the selected operation", async () => {
    const { client } = fakeClient({ withoutRename: true, update: () => never() })
    const { logger } = captureLogger()

    const failure = (await applySessionTitle(client, "ses_1", "x", { logger, timeoutMs: 20 }).catch(
      (error) => error,
    )) as RetitleTimeoutError

    expect(failure).toBeInstanceOf(RetitleTimeoutError)
    expect(failure.stage).toBe("update")
  })

  test("reports the write operation it would use without calling it", () => {
    const { client } = fakeClient()
    expect(selectTitleWrite(client.session)?.operation).toBe("rename")
    expect(selectTitleWrite(fakeClient({ withoutRename: true }).client.session)?.operation).toBe("update")
    expect(selectTitleWrite({} as never)).toBeUndefined()
  })

  test("never issues a request of its own", async () => {
    const original = globalThis.fetch
    let fetches = 0
    globalThis.fetch = (() => {
      fetches += 1
      throw new Error("the plugin must not hand-roll HTTP")
    }) as unknown as typeof fetch
    try {
      const { client, calls } = fakeClient()
      await applySessionTitle(client, "ses_1", "Deployment pipeline")
      expect(fetches).toBe(0)
      expect(calls.renames).toHaveLength(1)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("refreshSessionTitle", () => {
  function recordingTarget(order: string[]) {
    return {
      invalidate: (sessionID: string) => void order.push(`invalidate:${sessionID}`),
      sync: (sessionID: string) => {
        order.push(`sync:${sessionID}`)
        return Promise.resolve()
      },
    }
  }

  test("drops the cached session, then re-syncs it exactly once", async () => {
    const order: string[] = []
    const { logger, events } = captureLogger()

    await refreshSessionTitle(recordingTarget(order), "ses_1", { logger })

    expect(order).toEqual(["invalidate:ses_1", "sync:ses_1"])
    expect(events.map((event) => event.name)).toEqual(["session-refreshed"])
  })

  test("contains a failing sync so a successful write is never reported failed", async () => {
    const order: string[] = []
    const { logger, events, text } = captureLogger()
    const target = {
      invalidate: (sessionID: string) => void order.push(`invalidate:${sessionID}`),
      sync: () => Promise.reject(new Error("SESSION-TRANSCRIPT-MARKER")),
    }

    await refreshSessionTitle(target, "ses_1", { logger })

    expect(order).toEqual(["invalidate:ses_1"])
    expect(events.some((event) => event.name === "session-refresh-error")).toBe(true)
    expect(text()).not.toContain("SESSION-TRANSCRIPT-MARKER")
  })

  test("contains a throwing invalidate and still syncs", async () => {
    const order: string[] = []
    const { logger, events } = captureLogger()
    const target = {
      invalidate: () => {
        throw new Error("invalidate refused")
      },
      sync: (sessionID: string) => {
        order.push(`sync:${sessionID}`)
        return Promise.resolve()
      },
    }

    await refreshSessionTitle(target, "ses_1", { logger })

    expect(order).toEqual(["sync:ses_1"])
    expect(events.filter((event) => event.name === "session-refresh-error")).toHaveLength(1)
    expect(events.some((event) => event.name === "session-refreshed")).toBe(true)
  })

  test("bounds a hanging sync instead of hanging the apply", async () => {
    const { logger, events } = captureLogger()

    await refreshSessionTitle({ invalidate: () => {}, sync: () => never() }, "ses_1", { logger, timeoutMs: 20 })

    expect(events.find((event) => event.name === "session-refresh-error")?.fields.timedOut).toBe(true)
  })

  test("degrades to a diagnostic when the runtime stopped publishing refresh", async () => {
    const { logger, events } = captureLogger()

    await refreshSessionTitle(undefined, "ses_1", { logger })

    expect(events.filter((event) => event.name === "session-refresh-unsupported")).toHaveLength(2)
  })
})
