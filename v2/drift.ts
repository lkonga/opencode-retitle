// Tokenless lexical gate. Only plural nouns are stemmed: never strip -ing/-ed.
const STOP = new Set(`a an the and or but if then than as at by for from in into of on to with
i me my we us our you your he she it its they them their this that these those is am are
was were be been being have has had do does did not no yes can could would should will
may might must please thanks thank okay ok sure also just now next later before after
today tomorrow yesterday again still already finally first last currently meanwhile
want need like help let lets let's try use using make get add change update fix check
look see tell show explain implement ensure verify run work works working done really
actually basically well so about how what why when where which who all any some more
other same much very here there out up down go going request task thing things`.split(/\s+/))

export function nounStem(word: string): string {
  if (!/^[a-z]+$/.test(word)) return word
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y"
  if (/(ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1)
  return word
}

export function keywords(text: string): Set<string> {
  // Preserve punctuation inside identifiers, but not leading/trailing punctuation.
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+(?:[._'/-][\p{L}\p{N}]+)*/gu) ?? []
  return new Set(words.filter((word) => word.length > 1 && !STOP.has(word)).map(nounStem))
}

export function coverage(topic: ReadonlySet<string>, window: ReadonlySet<string>): number {
  if (!window.size) return 0
  return [...window].filter((word) => topic.has(word)).length / window.size
}

export interface DriftResult {
  readonly drift: boolean
  readonly abstained: boolean
  readonly coverage: number
  readonly driftScore: number
  readonly keywords: readonly string[]
  readonly window: readonly string[]
}
export interface DriftOptions {
  readonly windowTurns?: number
  readonly threshold?: number
  readonly confirmations?: number
  readonly semanticCheck?: (title: string, window: readonly string[]) => Promise<boolean>
}

export class TopicDriftDetector {
  private turns: string[] = []
  private lowChecks = 0
  private title?: string
  constructor(private readonly options: DriftOptions = {}) {}
  reset(): void { this.turns = []; this.lowChecks = 0; this.title = undefined }
  async check(title: string, turn: string): Promise<DriftResult> {
    if (this.title !== title) this.reset()
    this.title = title
    this.turns.push(turn)
    this.turns = this.turns.slice(-Math.max(1, Math.floor(this.options.windowTurns ?? 1)))
    const window = keywords(this.turns.join(" "))
    const score = coverage(keywords(title), window)
    const abstained = window.size < 3
    this.lowChecks = !abstained && score < (this.options.threshold ?? 0.3) ? this.lowChecks + 1 : 0
    let drift = this.lowChecks >= Math.max(1, this.options.confirmations ?? 2)
    if (drift && this.options.semanticCheck) {
      try { drift = await this.options.semanticCheck(title, [...this.turns]) }
      catch { drift = false }
      if (!drift) this.lowChecks = 0
    }
    return { drift, abstained, coverage: score, driftScore: 1 - score,
      keywords: [...window], window: [...this.turns] }
  }
}
