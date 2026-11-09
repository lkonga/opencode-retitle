// Pure tab snapshotting and metadata verification for /retitle-auto-sessions.

import type { RetitleAdapter } from "./adapter"
import type { RetitleUiContext } from "./dialogs"
import { DEFAULT_REFRESH_TIMEOUT_MS, TITLE_AGENT } from "./session-api"
import { createDeadline, withDeadline } from "./deadline"

export interface BatchSessionInfo {
  readonly id?: string
  readonly parentID?: string
  readonly agent?: string
  readonly title?: string
}

export interface BatchSessionData {
  readonly session?: {
    root?(sessionID: string): string | undefined
    get?(sessionID: string): BatchSessionInfo | undefined
    sync?(sessionID: string): Promise<void>
  }
}

export interface TabCandidateScope {
  readonly status: "ok" | "no-tabs"
  readonly candidateIDs: readonly string[]
  readonly totalTabs: number
}

/**
 * Snapshots open session tabs from `ui.tabs` synchronously once at invocation.
 * Deduplicates session IDs. Does NOT perform any asynchronous lookups or drop
 * unverified tabs here. Contains throws from `tabs.enabled` or `tabs.list`.
 */
export function snapshotTabCandidates(context: RetitleUiContext): TabCandidateScope {
  try {
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

    if (dedupedIDs.length === 0) {
      return { status: "no-tabs", candidateIDs: [], totalTabs: 0 }
    }

    return { status: "ok", candidateIDs: dedupedIDs, totalTabs: dedupedIDs.length }
  } catch {
    return { status: "no-tabs", candidateIDs: [], totalTabs: 0 }
  }
}

export type SessionVerificationResult =
  | { readonly verified: true; readonly sessionID: string }
  | { readonly verified: false; readonly sessionID: string; readonly reason: "child-session" | "helper-agent" | "unverified" }

/**
 * Verifies whether a captured sessionID is an eligible root session (not a child, not a helper).
 *
 * Requirements:
 * 1. Synchronously inspects cached `data.session.get(id)` and `data.session.root(id)`.
 *    If `get(id)` returns valid record where `parentID` is falsy and `agent !== TITLE_AGENT`:
 *    and `root(id)` matches `id`, it is accepted immediately.
 * 2. If `agent === TITLE_AGENT`, it is unconditionally excluded as a helper regardless of mutable title.
 * 3. If cached metadata is missing (`get(id)` undefined or `root/get` threw):
 *    Falls back to exact per-ID fetch via `data.session.sync(id)` or `client.session.get({ sessionID })`.
 * 4. Fails closed: if exact sync/get fails or the retrieved record does not match `id`, or has a `parentID`
 *    or has `agent === TITLE_AGENT`, it is rejected with a typed reason.
 */
export async function verifyCapturedSession(
  sessionID: string,
  context: RetitleUiContext,
  adapter: RetitleAdapter,
  data?: BatchSessionData | unknown,
): Promise<SessionVerificationResult> {
  const dataObj = (data ?? (context as any).data) as BatchSessionData | undefined
  const sessionApi = dataObj?.session

  const cachedResult = (): SessionVerificationResult | undefined => {
    try {
    const cached = sessionApi?.get?.(sessionID)
    if (cached && cached.id === sessionID && typeof sessionApi?.root === "function") {
      const rootID = sessionApi.root(sessionID)
      if (!rootID) return undefined
      if (cached.agent === TITLE_AGENT) {
        return { verified: false, sessionID, reason: "helper-agent" }
      }
      if (cached.parentID) {
        return { verified: false, sessionID, reason: "child-session" }
      }
      if (rootID !== sessionID) {
        return { verified: false, sessionID, reason: "child-session" }
      }
      // If cached has neither parentID nor helper agent, and root is self, we are verified
      return { verified: true, sessionID }
    }
    } catch {
      // Broken cache is not proof of eligibility.
    }
    return undefined
  }
  const cached = cachedResult()
  if (cached) return cached

  // Fallback: exact per-ID fetch
  // Try data.session.sync(sessionID) first
  if (typeof sessionApi?.sync === "function") {
    try {
      const deadline = createDeadline(DEFAULT_REFRESH_TIMEOUT_MS, "batch-metadata-sync")
      await withDeadline(Promise.resolve().then(() => sessionApi.sync!(sessionID)), deadline)
      const afterSync = cachedResult()
      if (afterSync) return afterSync
    } catch {
      // Sync failed, fall through to client.session.get
    }
  }

  // Try client.session.get({ sessionID })
  const clientApi = (context as any).client?.session ?? (adapter as any).ports?.client?.session
  if (typeof clientApi?.get === "function") {
    try {
      const deadline = createDeadline(DEFAULT_REFRESH_TIMEOUT_MS, "batch-metadata-get")
      const info = await withDeadline(Promise.resolve().then(() => clientApi.get({ sessionID }, { signal: deadline.signal })), deadline)
      if (info && info.id === sessionID) {
        if (info.agent === TITLE_AGENT) {
          return { verified: false, sessionID, reason: "helper-agent" }
        }
        if (info.parentID) {
          return { verified: false, sessionID, reason: "child-session" }
        }
        return { verified: true, sessionID }
      }
    } catch {
      // client.session.get failed
    }
  }

  // Fails closed
  return { verified: false, sessionID, reason: "unverified" }
}
