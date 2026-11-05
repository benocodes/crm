// The 15-minute cron's sync requests ([[CHN5]] D14, D75). STUB (red commit).
import type { RequestDeps } from './request.js'

export const MAIL_SYNC_CRON = '*/15 * * * *'
export async function requestDueSyncs(_d: RequestDeps): Promise<{ requested: string[]; failed: number }> {
  throw new Error('not implemented')
}
