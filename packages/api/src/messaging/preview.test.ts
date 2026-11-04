import { parseMarkdown } from 'chat'
import { describe, expect, it } from 'vitest'
import { messagePreview } from './preview.js'

const of = (markdown: string) => messagePreview({ formatted: parseMarkdown(markdown), text: '' }, 'message')

describe('messagePreview (D7)', () => {
  it('removes markdown syntax, collapses whitespace runs to one space and trims', () => {
    expect(of('  **Hello**\n\n   there,\t_friend_  ')).toBe('Hello there, friend')
  })
  it('cuts at 200 code points', () => {
    expect(Array.from(of('a'.repeat(250))).length).toBe(200)
    expect(of('b'.repeat(200))).toBe('b'.repeat(200))
  })
  it('never splits a surrogate pair at the cut', () => {
    const out = of('a'.repeat(199) + '😀😀')
    expect(Array.from(out).length).toBe(200)
    expect(out.endsWith('😀')).toBe(true)
    expect(out.length).toBe(201) // 199 units + one pair
    // a lone surrogate would not survive a round trip
    expect(new TextDecoder().decode(new TextEncoder().encode(out))).toBe(out)
  })
  it('cuts after collapsing, not before', () => {
    expect(of('x' + ' '.repeat(500) + 'y')).toBe('x y')
  })
  it('a reaction previews from its text (the emoji), under the same rule', () => {
    expect(messagePreview({ formatted: parseMarkdown(''), text: ' 👍 \n' }, 'reaction')).toBe('👍')
    expect(messagePreview({ formatted: parseMarkdown('ignored'), text: '👍' }, 'reaction')).toBe('👍')
  })
})
