import { describe, expect, it } from 'vitest'
import { sendInput } from './send-input.js'

const base = { connection_id: '019a0000-0000-7000-8000-000000000001', mode: 'new', subject: 'Hello 世界', to: ['a@example.test'], body: 'héllo\n世界' }
describe('Gmail send input contract', () => {
  it('normalises and deduplicates recipients across To Cc Bcc in precedence order', () => {
    expect(sendInput.parse({ ...base, to: [' A@Example.Test ', 'a@example.test'], cc: ['a@example.test','b@example.test'], bcc: ['B@example.test','c@example.test'] })).toMatchObject({ to: ['a@example.test'], cc: ['b@example.test'], bcc: ['c@example.test'] })
  })
  it.each([
    { mode: 'reply' }, { mode: 'reply', thread_id: base.connection_id }, { thread_id: base.connection_id }, { subject: undefined },
    { to: [] }, { to: ['not an address'] }, { to: ['a@example.test\r\nBcc:x@example.test'] }, { subject: 'hi\nBcc:x' },
    { body: '😀'.repeat(16385) }, { to: Array.from({length: 51},(_,i)=>`a${i}@example.test`) }, { attachments: [] },
  ])('refuses invalid or incompatible send fields %j', patch => expect(sendInput.safeParse({ ...base,...patch }).success).toBe(false))
  it('accepts exact UTF-8 body boundary and explicit reply without subject', () => {
    expect(sendInput.safeParse({ ...base,body:'😀'.repeat(16384) }).success).toBe(true)
    expect(sendInput.safeParse({...base,subject:'界'.repeat(332)}).success).toBe(true)
    expect(sendInput.safeParse({...base,subject:'界'.repeat(333)}).success).toBe(false)
    const { subject: _subject,...reply } = base
    expect(sendInput.parse({ ...reply,mode:'reply',thread_id:base.connection_id })).toMatchObject({ mode:'reply',body:base.body })
  })
})
