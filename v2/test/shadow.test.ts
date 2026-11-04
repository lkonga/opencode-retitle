import { describe, expect, test } from "bun:test"
import { TitleCandidateQueue, candidateFingerprint, type CandidateProposal } from "../shadow"
import type { SettingsStorage } from "../settings"

export function memoryStorage(): SettingsStorage {
  const records = new Map<string, object>()
  return { store<T extends object>(key: string, options: { readonly initial: T }) {
    const value = (records.get(key) ?? structuredClone(options.initial)) as T
    records.set(key, value)
    return [value, async (mutation: (draft: T) => void) => { mutation(value) }] as const
  } }
}
const proposal = (title: string, sessionID = "session"): CandidateProposal => ({
  sessionID, proposedTitle: title, previousTitle: "old title", reason: "drift",
  evidence: { turnIndex: 10, keywords: ["docker", "registry", "container"] },
})
describe("title proposal queue", () => {
  test("bounds live FIFO while preserving audit and monotonic IDs", async () => {
    const q = new TitleCandidateQueue(memoryStorage(), 2, () => 42)
    for (const title of ["one", "two", "three"]) await q.propose(proposal(title))
    expect(q.pending().map((c) => c.id)).toEqual([2, 3])
    expect(q.list().map((c) => c.state)).toEqual(["superseded", "pending", "pending"])
    expect(q.list()[0]!.createdAt).toBe(42)
  })
  test("rejection survives reload and suppresses reordered keywords", async () => {
    const storage = memoryStorage()
    const q = new TitleCandidateQueue(storage)
    const c = (await q.propose(proposal("Docker Registry")))!
    await q.reject(c.id)
    const reload = new TitleCandidateQueue(storage)
    expect(await reload.propose({ ...proposal(" docker   registry "), evidence: {
      turnIndex: 11, keywords: ["container", "registry", "docker", "docker"],
    } })).toBeUndefined()
    expect(await reload.propose(proposal("Docker Registry", "another"))).toBeDefined()
  })
  test("foreign rename invalidates only pending titles in that session", async () => {
    const q = new TitleCandidateQueue(memoryStorage())
    await q.propose(proposal("one")); await q.propose(proposal("two", "other"))
    await q.invalidateForeignRename("session")
    expect(q.pending().map((c) => c.sessionID)).toEqual(["other"])
  })
  test("accept is terminal and snapshots cannot mutate storage", async () => {
    const q = new TitleCandidateQueue(memoryStorage())
    const c = (await q.propose(proposal("one")))!
    c.state = "rejected"
    expect(await q.accept(c.id)).toBe(true)
    expect(await q.reject(c.id)).toBe(false)
    expect(q.list()[0]!.state).toBe("accepted")
  })
  test("deduplicates pending proposals and skips unchanged titles", async () => {
    const q = new TitleCandidateQueue(memoryStorage())
    await Promise.all([q.propose(proposal("one")), q.propose(proposal("one"))])
    expect(q.pending()).toHaveLength(1)
    expect(await q.propose(proposal("old title"))).toBeUndefined()
    expect(candidateFingerprint("title", ["b", "a"])).toBe(candidateFingerprint(" TITLE ", ["a", "b"]))
  })
  test("shared durable claim permits one writer and retains the turn watermark", async () => {
    const storage = memoryStorage()
    const first = new TitleCandidateQueue(storage)
    const second = new TitleCandidateQueue(storage)
    expect(await first.claimEvaluation("s", 10)).toBe(true)
    expect(await second.claimEvaluation("s", 10)).toBe(false)
    expect(await second.claimEvaluation("s", 11)).toBe(false)
    await first.releaseEvaluation("s", 10)
    expect(await second.claimEvaluation("s", 10)).toBe(false)
    expect(await second.claimEvaluation("s", 11)).toBe(true)
  })
})
