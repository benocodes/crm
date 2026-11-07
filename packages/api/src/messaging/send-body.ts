import type { ObjectStore } from '../objects/store.js'
export type SendBody = { sha256: string; size_bytes: number }
export const sendBodyKey = (org: string, hash: string): string => `${org}/${hash}`
export async function describeSendBody(_body: string): Promise<SendBody> { return { sha256: '', size_bytes: 0 } }
export async function storeSendBody(_store: ObjectStore, _org: string, _text: string): Promise<SendBody> { return describeSendBody(_text) }
export async function readSendBody(_store: ObjectStore, _org: string, _body: unknown): Promise<string> { return '' }
