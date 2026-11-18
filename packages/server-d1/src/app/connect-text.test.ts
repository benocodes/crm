import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apiKeyDirections, LOGIN_STEPS, loginCommand, MCP_NOTE } from './connect-text.js'

// [[UI461]] D12, P3 (group 4): the one source of the connect-an-agent text; /connect imports it back.
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
  it('src/connect keeps no copy of the strings', () => {
    for (const f of ['view-model.ts', 'view.tsx', 'controller.ts']) {
      const src = readFileSync(new URL(`../connect/${f}`, import.meta.url), 'utf8')
      expect(src, f).not.toContain('vibase login --')
      expect(src, f).not.toContain('VIBASE_API_KEY')
      expect(src, f).not.toContain('remote MCP server')
    }
    const vm = readFileSync(new URL('../connect/view-model.ts', import.meta.url), 'utf8')
    expect(vm).toMatch(/from '\.\.\/app\/connect-text\.js'/)
  })
})
