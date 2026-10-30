// Thread resolution for the capture unit ([[CORE25]] D3, D28; [[CORE68]] P10, P14). Pure: it works over facts the plan
// phase read and returns what `recordMessages` writes and what it must find unchanged at commit.

export interface HintSource {
  external_id: string
  in_reply_to: string | null
  thread_hints: readonly string[]
}
export interface ThreadInput extends HintSource {
  provider_thread_id: string
  subject: string | null
}
/** What the plan phase saw. */
export interface PlannedThreads {
  /** external_id -> thread_id of messages already in the database. */
  existing: ReadonlyMap<string, string>
  /** provider_thread_id -> thread_id of the connection's aliases. */
  aliases: ReadonlyMap<string, string>
  /** external_id -> the nearest hint that exists in the database (lowest rank). */
  ancestors: ReadonlyMap<string, { rank: number; thread_id: string }>
}
export type ThreadOutcome = 'existing' | 'alias' | 'ancestor' | 'new'
export interface ThreadDecision {
  external_id: string
  outcome: ThreadOutcome
  thread_id: string
  chosen_rank: number | null
}
export interface ThreadResolution {
  decisions: ThreadDecision[]
  new_threads: Array<{ thread_id: string; subject: string | null }>
  aliases_to_add: Array<{ provider_thread_id: string; thread_id: string }>
  /** Message keys that must still be absent at commit: the new message keys plus the hints nearer than the chosen one. */
  absent: string[]
}

/** The candidate list of a message, nearest first: `in_reply_to`, then `References` newest first; no nulls, duplicates or the message's own key (P14). */
export function rankedHints(m: HintSource): string[] {
  if (m.thread_hints.length > 20) throw new Error('thread_hints holds at most 20 entries')
  const out: string[] = []
  for (const h of [m.in_reply_to, ...m.thread_hints]) {
    if (h === null || h === m.external_id || out.includes(h)) continue
    out.push(h)
  }
  return out
}

/**
 * `sorted` is the chunk in `(occurred_at, external_id)` order. Per message, D3's order: already stored (or earlier in the
 * chunk) -> `existing`; the pair's alias -> `alias`; the nearest ancestor, an earlier chunk message or the planned database
 * one, whichever ranks lower -> `ancestor`; otherwise a `new` thread. Every pair without an alias gets one to the thread
 * the message ends up in (the first message of a pair sets it).
 */
export function resolveThreads(sorted: readonly ThreadInput[], planned: PlannedThreads, newId: () => string): ThreadResolution {
  const decisions: ThreadDecision[] = []
  const newThreads: ThreadResolution['new_threads'] = []
  const aliasesToAdd: ThreadResolution['aliases_to_add'] = []
  const absent = new Set<string>()
  const chunkThreads = new Map<string, string>() // external_id -> thread of messages decided earlier in this chunk
  const chunkAliases = new Map<string, string>()

  for (const m of sorted) {
    const hints = rankedHints(m)
    let outcome: ThreadOutcome
    let threadId: string
    let chosenRank: number | null = null

    const stored = planned.existing.get(m.external_id)
    const earlier = chunkThreads.get(m.external_id)
    const alias = planned.aliases.get(m.provider_thread_id) ?? chunkAliases.get(m.provider_thread_id)
    if (stored !== undefined || earlier !== undefined) {
      outcome = 'existing'
      threadId = (stored ?? earlier)!
    } else {
      absent.add(m.external_id)
      if (alias !== undefined) {
        outcome = 'alias'
        threadId = alias
      } else {
        let chunkRank = -1
        for (let i = 0; i < hints.length; i++) {
          if (chunkThreads.has(hints[i]!)) {
            chunkRank = i
            break
          }
        }
        const db = planned.ancestors.get(m.external_id)
        if (chunkRank >= 0 && (db === undefined || chunkRank <= db.rank)) {
          outcome = 'ancestor'
          threadId = chunkThreads.get(hints[chunkRank]!)!
          chosenRank = chunkRank
        } else if (db !== undefined) {
          outcome = 'ancestor'
          threadId = db.thread_id
          chosenRank = db.rank
        } else {
          outcome = 'new'
          threadId = newId()
          newThreads.push({ thread_id: threadId, subject: m.subject })
        }
        // Nothing nearer than the chosen hint existed when we planned; it must still not (all hints for a new thread).
        for (const h of chosenRank === null ? hints : hints.slice(0, chosenRank)) absent.add(h)
      }
      chunkThreads.set(m.external_id, threadId)
    }
    if (alias === undefined) {
      aliasesToAdd.push({ provider_thread_id: m.provider_thread_id, thread_id: threadId })
      chunkAliases.set(m.provider_thread_id, threadId)
    }
    decisions.push({ external_id: m.external_id, outcome, thread_id: threadId, chosen_rank: chosenRank })
  }
  return { decisions, new_threads: newThreads, aliases_to_add: aliasesToAdd, absent: [...absent] }
}
