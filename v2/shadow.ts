import type { SettingsStorage } from "./settings"

export type CandidateState = "pending" | "accepted" | "rejected" | "superseded"
export interface TitleCandidate {
  readonly id: number
  readonly sessionID: string
  readonly proposedTitle: string
  readonly previousTitle: string
  readonly reason: "cadence" | "drift" | "compaction" | "manual" | "fork"
  readonly evidence: {
    readonly turnIndex: number
    readonly window?: readonly string[]
    readonly driftScore?: number
    readonly keywords: readonly string[]
    readonly rationale?: string
  }
  readonly createdAt: number
  state: CandidateState
}
export type CandidateProposal = Omit<TitleCandidate, "id" | "state" | "createdAt">
type QueueState = { nextID: number; candidates: TitleCandidate[]; rejected: string[];
  claims?: Record<string, { turnIndex: number; until: number }> }
export const QUEUE_KEY = "title-candidates"

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ")
export function candidateFingerprint(title: string, words: readonly string[]): string {
  const value = JSON.stringify([normalize(title), [...new Set(words.map(normalize))].sort()])
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(16)
}
const fingerprint = (c: CandidateProposal) => `${c.sessionID}:${candidateFingerprint(c.proposedTitle, c.evidence.keywords)}`
const clone = (c: TitleCandidate): TitleCandidate => ({ ...c, evidence: { ...c.evidence,
  keywords: [...c.evidence.keywords], window: c.evidence.window && [...c.evidence.window] } })

/** Bound the live FIFO, not its append-only audit trail. All mutations run in storage transactions. */
export class TitleCandidateQueue {
  private readonly store: QueueState
  private readonly update: (mutation: (draft: QueueState) => void) => Promise<void>
  constructor(storage: SettingsStorage, private readonly maxSize = 5, private readonly now = Date.now) {
    const [store, update] = storage.store<QueueState>(QUEUE_KEY, {
      initial: { nextID: 1, candidates: [], rejected: [] },
    })
    this.store = store
    this.update = update
  }
  list(sessionID?: string): readonly TitleCandidate[] {
    return this.store.candidates.filter((c) => !sessionID || c.sessionID === sessionID).map(clone)
  }
  pending(sessionID?: string): readonly TitleCandidate[] {
    return this.list(sessionID).filter((c) => c.state === "pending")
  }
  async propose(proposal: CandidateProposal): Promise<TitleCandidate | undefined> {
    let result: TitleCandidate | undefined
    const title = proposal.proposedTitle.trim()
    if (!title || normalize(title) === normalize(proposal.previousTitle)) return
    await this.update((draft) => {
      const key = fingerprint({ ...proposal, proposedTitle: title })
      if (draft.rejected.includes(key) || draft.candidates.some((c) => c.state === "pending" && fingerprint(c) === key)) return
      const candidate = clone({ ...proposal, proposedTitle: title, id: draft.nextID++, createdAt: this.now(), state: "pending" })
      draft.candidates.push(candidate)
      const live = draft.candidates.filter((c) => c.state === "pending")
      while (live.length > Math.max(1, Math.floor(this.maxSize))) live.shift()!.state = "superseded"
      result = clone(candidate)
    })
    return result
  }
  async transition(id: number, state: Exclude<CandidateState, "pending">): Promise<boolean> {
    let changed = false
    await this.update((draft) => {
      const candidate = draft.candidates.find((c) => c.id === id && c.state === "pending")
      if (!candidate) return
      candidate.state = state
      if (state === "rejected") draft.rejected.push(fingerprint(candidate))
      changed = true
    })
    return changed
  }
  accept(id: number): Promise<boolean> { return this.transition(id, "accepted") }
  reject(id: number): Promise<boolean> { return this.transition(id, "rejected") }
  /** Claim before generation, not after it; retained turn watermark deduplicates broadcasts. */
  async claimEvaluation(sessionID: string, turnIndex: number): Promise<boolean> {
    let granted = false
    await this.update((draft) => {
      draft.claims ??= {}
      const key = `session:${sessionID}`
      const claim = draft.claims[key]
      if (claim && (claim.turnIndex >= turnIndex || claim.until > this.now())) return
      draft.claims[key] = { turnIndex, until: this.now() + 120_000 }
      granted = true
    })
    return granted
  }
  async releaseEvaluation(sessionID: string, turnIndex: number): Promise<void> {
    await this.update((draft) => {
      const claim = draft.claims?.[`session:${sessionID}`]
      if (claim?.turnIndex === turnIndex) claim.until = 0
    })
  }
  async invalidateForeignRename(sessionID: string): Promise<void> {
    await this.update((draft) => {
      for (const c of draft.candidates) if (c.sessionID === sessionID && c.state === "pending") c.state = "superseded"
    })
  }
}
