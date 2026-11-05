// Test-only ([[CHN149]] D65). The kit around the capture pages: a seeded Gmail connection (through the real `connectOperation`, so the
// connection, credential, cursor and own identities are exactly what a connect writes) and a driver that runs pages to completion the way
// [[CHN141]]'s Workflow will: backfill when never synced, then history pages, a recovery scan on `expired`. Web APIs only: the workerd smoke
// bundles this file. Not in the production barrel.
import { connectOperation } from '../connections/connect.js'
import { sealToken } from '../connections/credentials.js'
import { beginScan, captureHistoryPage, captureScanPage, loadSyncState, type GmailSyncDeps, type Outcome, type PageDone, type Scan } from '../channels/gmail/sync.js'
import type { Engine } from './engines.js'

/** What seeding needs of an engine: the unit environment, a runner and (for `lastSyncedAt`) raw D1. The workerd smoke passes its own. */
export type SeedTarget = Pick<Engine, 'env' | 'run' | 'd1'>

export interface SeedGmailConnection {
  key: Uint8Array
  keyVersion?: number
  refreshToken: string
  sub?: string
  mailbox?: string
  historyId?: string
  /** Set the cursor's `last_synced_at` (a connection that has synced); default null (never synced). */
  lastSyncedAt?: string | null
}
/** Connects a mailbox on a D1 engine as the engine's user (the owner). Returns the connection id. */
export async function seedGmailConnection(e: SeedTarget, p: SeedGmailConnection): Promise<string> {
  const mailbox = p.mailbox ?? 'owner@vault.test'
  const op = connectOperation(e.env(), {
    google_sub: p.sub ?? `sub-${mailbox}`,
    mailbox,
    own_addresses: [mailbox],
    granted_scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
    ciphertext: await sealToken(p.key, p.refreshToken, crypto.getRandomValues(new Uint8Array(12))),
    key_version: p.keyVersion ?? 1,
    history_id: p.historyId ?? '1000',
  })
  const id = (await e.run(op)).value.connection_id
  if (p.lastSyncedAt) await e.d1!.prepare('update mail_sync_cursors set last_synced_at = ? where connection_id = ?').bind(p.lastSyncedAt, id).run()
  return id
}

export interface SyncRun {
  /** `complete`, or the outcome that stopped the run. */
  outcome: 'complete' | Outcome['outcome']
  pages: number
  captured: number
  existing: number
  skipped: number
  scans: Array<'backfill' | 'recovery'>
}

/** Runs pages to completion. `maxPages` (default 200) turns a loop bug into a failure instead of a hang. */
export async function runGmailSync(deps: GmailSyncDeps, connectionId: string, opts: { maxPages?: number } = {}): Promise<SyncRun> {
  const max = opts.maxPages ?? 200
  const run: SyncRun = { outcome: 'complete', pages: 0, captured: 0, existing: 0, skipped: 0, scans: [] }
  const take = (r: PageDone): void => {
    if (++run.pages > max) throw new Error('runGmailSync: too many pages')
    run.captured += r.captured
    run.existing += r.existing
    run.skipped += r.skipped
  }
  const stop = (o: Outcome['outcome']): SyncRun => ({ ...run, outcome: o })
  const scan = async (kind: 'backfill' | 'recovery'): Promise<Outcome['outcome'] | 'done'> => {
    const start = await beginScan(deps, connectionId, kind)
    if (start.outcome !== 'scan') return start.outcome
    run.scans.push(kind)
    const s: Scan = start.scan
    let token: string | null = null
    for (;;) {
      const r = await captureScanPage(deps, connectionId, s, token)
      if (r.outcome !== 'page') return r.outcome
      take(r)
      if (r.next_page_token === null) return 'done'
      token = r.next_page_token
    }
  }
  const state = await loadSyncState(deps, connectionId)
  if (!state) return stop('inactive')
  if (state.last_synced_at === null) {
    const o = await scan('backfill')
    if (o !== 'done') return stop(o)
  }
  for (;;) {
    const r = await captureHistoryPage(deps, connectionId)
    if (r.outcome === 'expired') {
      const o = await scan('recovery')
      if (o !== 'done') return stop(o)
      continue
    }
    if (r.outcome !== 'page') return stop(r.outcome)
    take(r)
    if (r.next_page_token === null) return run
  }
}
