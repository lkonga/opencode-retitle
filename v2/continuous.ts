import type { RetitleAdapter } from "./adapter"
import { readContinuous } from "./continuous-settings"
import { TopicDriftDetector } from "./drift"
import { defaultSettings } from "./settings"
import { executeRetitle } from "./runner"

export interface ContinuousTurn {
  readonly sessionID: string
  readonly title: string
  readonly turnIndex: number
  readonly text: string
}
type SessionState = {
  title: string; lastTurn: number; since: number; paused: boolean; busy: boolean
  drift: TopicDriftDetector
}

/** Background-only evaluator. The host observer supplies completed user turns, never a dialog. */
export class ContinuousRetitle {
  private readonly sessions = new Map<string, SessionState>()
  constructor(private readonly adapter: RetitleAdapter,
    private readonly autoApply: (sessionID: string, adapter: RetitleAdapter) => Promise<string | undefined>, private readonly changed: () => void = () => {}) {}
  async observe(turn: ContinuousTurn): Promise<void> {
    const config = readContinuous(this.adapter.settings.read().continuous)
    let state = this.sessions.get(turn.sessionID)
    if (!state) {
      state = { title: turn.title, lastTurn: turn.turnIndex, since: turn.turnIndex,
        paused: false, busy: false, drift: new TopicDriftDetector() }
      this.sessions.set(turn.sessionID, state)
      return // Do not replay restored history as fresh turns.
    }
    if (turn.title !== state.title) {
      state.title = turn.title
      state.since = turn.turnIndex
      state.drift.reset()
      state.paused = config.respectManualRename
      await this.adapter.candidates?.invalidateForeignRename(turn.sessionID)
      this.changed()
    }
    if (!config.enabled) {
      state.lastTurn = turn.turnIndex; state.since = turn.turnIndex; state.drift.reset()
      return
    }
    if (!config.respectManualRename) state.paused = false
    if (state.paused || turn.turnIndex <= state.lastTurn) return
    state.lastTurn = turn.turnIndex
    if (state.busy) return
    const drift = config.mode === "semantic" ? await state.drift.check(turn.title, turn.text) : undefined
    if (config.mode === "semantic" ? !drift?.drift : turn.turnIndex - state.since < config.turnInterval) return
    state.busy = true
    const queue = this.adapter.candidates
    let claimed = false
    try {
      if (!queue) return // Durable coordination is required for every background run.
      claimed = await queue.claimEvaluation(turn.sessionID, turn.turnIndex)
      if (!claimed) return
      const currentConfig = readContinuous(this.adapter.settings.read().continuous)
      if (!currentConfig.enabled || currentConfig.shadowMode !== config.shadowMode || state.paused || state.title !== turn.title) return
      if (!config.shadowMode) {
        const guarded: RetitleAdapter = { ...this.adapter, ports: { ...this.adapter.ports,
          applyTitle: async (sessionID, title) => {
            const latest = readContinuous(this.adapter.settings.read().continuous)
            if (state.paused || state.title !== turn.title || !latest.enabled || latest.shadowMode) throw new Error("Continuous title write invalidated")
            state.title = title // Attribute the ensuing reactive rename before issuing the write.
            try { await this.adapter.ports.applyTitle(sessionID, title) }
            catch (error) { state.title = turn.title; throw error }
          },
        } }
        const applied = await this.autoApply(turn.sessionID, guarded)
        if (applied !== undefined) { state.title = applied; state.since = turn.turnIndex; state.drift.reset() }
        return
      }
      const grant = this.adapter.gate.begin()
      if (!grant.ok) return
      try {
        const outcome = await executeRetitle(this.adapter.ports, {
          sessionID: turn.sessionID, settings: defaultSettings(this.adapter.settings.read()), logger: this.adapter.logger,
        })
        const latest = readContinuous(this.adapter.settings.read().continuous)
        if (outcome.status !== "ok" || state.title !== turn.title || state.paused || !latest.enabled || !latest.shadowMode) return
        await queue.propose({ sessionID: turn.sessionID, previousTitle: turn.title, proposedTitle: outcome.title,
          reason: config.mode === "semantic" ? "drift" : "cadence", evidence: { turnIndex: turn.turnIndex,
            keywords: drift?.keywords ?? [], window: drift?.window, driftScore: drift?.driftScore } })
        state.since = turn.turnIndex
        this.changed()
      } finally { this.adapter.gate.end(grant.token) }
    } catch (error) { this.adapter.logger.event("continuous-error", { error }) }
    finally {
      state.busy = false
      if (claimed) await queue?.releaseEvaluation(turn.sessionID, turn.turnIndex)
    }
  }
}
