import { describe, expect, it } from 'vitest'
import { apiKeyDirections, LOGIN_STEPS, loginCommand, MCP_NOTE } from './connect-text.js'

// [[UI461]] D12, P3 (group 4): the one source of the connect-an-agent text, used by the app. [[UI476]] deleted the old connect page that imported it back, and with it the no-copy check.
describe('connect-text', () => {
  it('the login command carries the origin', () => {
    expect(loginCommand('https://w.test')).toBe('vibase login --server https://w.test')
    expect(LOGIN_STEPS).toMatch(/open the link/i)
  })
  it('the API-key line reads the key from stdin and says an owner creates it (D9)', () => {
    const d = apiKeyDirections('https://w.test')
    expect(d.command).toBe('printf %s "$VIBASE_API_KEY" | vibase login --api-key --server https://w.test')
    expect(d.note).toMatch(/owner creates a key/)
    expect(d.note).toMatch(/stdin/)
  })
  it('the MCP note names the remote MCP server', () => {
    expect(MCP_NOTE).toMatch(/remote MCP server/)
  })
})
