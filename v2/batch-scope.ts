// Pure tab snapshotting and helper session filtering for /retitle-auto-sessions.

import type { RetitleUiContext } from "./dialogs"
import { HELPER_TITLE, TITLE_AGENT } from "./session-api"

export interface BatchSessionData {
  readonly session?: {
    root?(sessionID: string): string | undefined
    get?(sessionID: string): {
      readonly parentID?: string
      readonly agent?: string
      readonly title?: string
    } | undefined
  }
}

export interface TabCandidateScope {
  readonly status: "ok" | "no-tabs"
  readonly candidateIDs: readonly string[]
  readonly totalTabs: number
}

/**
 * Snapshots open session tabs from `ui.tabs` synchronously once at invocation.
 * Deduplicates session IDs and defensively filters out helper/child sessions:
 * 1. `data.session.root(id) !== id`
 * 2. `data.session.get(id)` has `parentID`
 * 3. `data.session.get(id)` is known plugin helper (`agent === TITLE_AGENT && title === HELPER_TITLE`)
 */
export function snapshotTabCandidates(context: RetitleUiContext, data?: BatchSessionData | unknown): TabCandidateScope {
  const tabsApi = context.ui.tabs
  if (!tabsApi || !tabsApi.enabled()) {
    return { status: "no-tabs", candidateIDs: [], totalTabs: 0 }
  }

  const rawTabs = tabsApi.list()
  if (!rawTabs || rawTabs.length === 0) {
    return { status: "no-tabs", candidateIDs: [], totalTabs: 0 }
  }

  const seen = new Set<string>()
  const dedupedIDs: string[] = []
  for (const tab of rawTabs) {
    if (tab?.sessionID && !seen.has(tab.sessionID)) {
      seen.add(tab.sessionID)
      dedupedIDs.push(tab.sessionID)
    }
  }

  const candidateIDs: string[] = []
  const dataObj = (data ?? (context as any).data) as BatchSessionData | undefined
  const rootLookup = dataObj?.session?.root
  const getLookup = dataObj?.session?.get

  for (const id of dedupedIDs) {
    let isCandidate = true
    if (typeof rootLookup === "function") {
      try {
        const rootID = rootLookup(id)
        if (rootID && rootID !== id) isCandidate = false
      } catch {
        // ignore error and proceed to metadata check
      }
    }

    if (isCandidate && typeof getLookup === "function") {
      try {
        const info = getLookup(id)
        if (info) {
          if (info.parentID) isCandidate = false
          if (info.agent === TITLE_AGENT && info.title === HELPER_TITLE) isCandidate = false
        }
      } catch {
        // ignore error and retain defensive candidate
      }
    }

    if (isCandidate) candidateIDs.push(id)
  }

  if (candidateIDs.length === 0) {
    return { status: "no-tabs", candidateIDs: [], totalTabs: dedupedIDs.length }
  }

  return { status: "ok", candidateIDs, totalTabs: candidateIDs.length }
}
