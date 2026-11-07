import { expect, it } from 'vitest'
import { memoryObjectStore } from '../objects/store.js'
import { describeSendBody, readSendBody, sendBodyKey, storeSendBody } from './send-body.js'

const hash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
it('pins the private outbound namespace and literal digest; preserves exact UTF-8 bytes', async () => {
  const store = memoryObjectStore()
  expect(sendBodyKey('org-1',hash)).toBe(`orgs/org-1/outbound/sha256/${hash}/body.txt`)
  expect(await describeSendBody('abc')).toEqual({sha256:hash,size_bytes:3})
  const desc = await storeSendBody(store,'org-1','hé\r\n世界')
  expect(desc.size_bytes).toBe(11)
  expect(await readSendBody(store,'org-1',desc)).toBe('hé\r\n世界')
})
it('missing, tampered and cross-organisation objects fail closed without exposing keys', async () => {
  const store = memoryObjectStore()
  const desc = await storeSendBody(store,'org-1','abc')
  await expect(readSendBody(store,'org-2',desc)).rejects.toMatchObject({code:'content_unavailable'})
  await store.put(`orgs/org-1/outbound/sha256/${hash}/body.txt`,'abd')
  await expect(readSendBody(store,'org-1',desc)).rejects.toMatchObject({code:'content_unavailable'})
})
