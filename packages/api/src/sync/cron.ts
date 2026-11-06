// The 15-minute cron's sync requests ([[CHN5]] D14, D75): a request for every due connection. One connection failing does not stop the others.
import { dueConnections, requestSync, type RequestDeps } from './request.js'

export const MAIL_SYNC_CRON = '*/15 * * * *'

export async function requestDueSyncs(d: RequestDeps): Promise<{ requested: string[]; failed: number }> {
  const due = await dueConnections(d, d.clock())
  const requested: string[] = []
  let failed = 0
  for (const id of due) {
    try {
      await requestSync(d, id)
      requested.push(id)
    } catch (err) {
      failed++
      // The kind only: nothing of an instance error is worth a line.
      console.error(`[cron] sync request failed for ${id}: ${err instanceof Error ? err.name : 'error'}`)
    }
  }
  return { requested, failed }
}
