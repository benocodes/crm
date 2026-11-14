import { describe, expect, it } from 'vitest'
import { invitationUrl, passwordResetUrl } from './token.js'

// [[UI246]] D6: a reset link is `<base>/reset-password#token=<token>`, built from the `token` Better Auth hands `sendResetPassword`: the token is in the fragment, never a path segment or query.
describe('passwordResetUrl', () => {
  it.each([
    ['https://api.example.test', 'https://api.example.test/reset-password#token=abc'],
    ['https://api.example.test/', 'https://api.example.test/reset-password#token=abc'],
    ['https://api.example.test///', 'https://api.example.test/reset-password#token=abc'],
    ['http://localhost:8787', 'http://localhost:8787/reset-password#token=abc'],
  ])('base %s gives %s', (base, expected) => {
    expect(passwordResetUrl(base, 'abc')).toBe(expected)
  })

  it('keeps the token only in the fragment: nothing after the path reaches a server', () => {
    const url = new URL(passwordResetUrl('https://api.example.test', 'tok-en_1'))
    expect(url.pathname).toBe('/reset-password')
    expect(url.search).toBe('')
    expect(url.hash).toBe('#token=tok-en_1')
  })

  it('sits beside invitationUrl with the same base handling', () => {
    expect(passwordResetUrl('https://h.test/', 't').replace('/reset-password', '')).toBe(invitationUrl('https://h.test/', 't').replace('/invite', ''))
  })
})
