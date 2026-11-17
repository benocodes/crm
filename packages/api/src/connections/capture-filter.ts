import type { ExcludeHook } from '../messaging/pipeline.js'
import type { CaptureSettings } from './capture-settings.js'

export const GROUP_ADDRESS_NAMES: readonly string[] = []
export const GROUP_ADDRESS_PREFIXES: readonly string[] = []
export const PERSONAL_MAIL_DOMAINS: readonly string[] = []

export type CaptureFilterSettings = Pick<
  CaptureSettings,
  'blocked_addresses' | 'blocked_domains' | 'exclude_group_addresses' | 'exclude_personal_domains'
>

export function captureFilter(_settings: CaptureFilterSettings, _mailbox: string): ExcludeHook {
  return () => null
}
