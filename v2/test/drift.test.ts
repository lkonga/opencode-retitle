import { describe, expect, test } from "bun:test"
import { coverage, keywords, nounStem, TopicDriftDetector } from "../drift"

describe("topic drift", () => {
  test("coverage uses window as denominator", () => {
    expect(coverage(keywords("database"), keywords("database migration postgres"))).toBeCloseTo(1 / 3)
    expect(coverage(keywords("database"), new Set())).toBe(0)
  })
  test("preserves identifier punctuation", () => {
    expect([...keywords("package.json, tsconfig.json; auth-service foo_bar")]).toEqual([
      "package.json", "tsconfig.json", "auth-service", "foo_bar",
    ])
  })
  test("filters stop words and stems nouns only", () => {
    expect([...keywords("Please now help me fix the packages and dependencies")]).toEqual(["package", "dependency"])
    expect(nounStem("running")).toBe("running")
    expect(nounStem("deployed")).toBe("deployed")
    expect(nounStem("status")).toBe("status")
  })
  test("low signal abstains and breaks consecutive checks", async () => {
    const detector = new TopicDriftDetector()
    await detector.check("database", "docker container registry")
    expect((await detector.check("database", "okay thanks")).abstained).toBe(true)
    expect((await detector.check("database", "docker container registry")).drift).toBe(false)
  })
  test("requires two consecutive low coverage checks", async () => {
    const detector = new TopicDriftDetector()
    expect((await detector.check("database migrations postgres", "docker container registry")).drift).toBe(false)
    expect((await detector.check("database migrations postgres", "docker container registry")).drift).toBe(true)
    expect((await detector.check("database migrations postgres", "database migrations postgres")).drift).toBe(false)
  })
  test("window defaults to last turn, configurable aggregation", async () => {
    const detector = new TopicDriftDetector({ windowTurns: 2 })
    await detector.check("database", "docker container")
    expect((await detector.check("database", "registry")).keywords).toHaveLength(3)
    expect((await detector.check("changed title", "registry")).abstained).toBe(true)
  })
  test("semantic veto and failure are fail-closed", async () => {
    for (const semanticCheck of [async () => false, async (): Promise<boolean> => { throw new Error("offline") }]) {
      const detector = new TopicDriftDetector({ confirmations: 1, semanticCheck })
      expect((await detector.check("database", "docker container registry")).drift).toBe(false)
    }
  })
})
