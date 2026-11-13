import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSecretsPath, loadSecrets, parseDotenv } from './secrets.js'
import { ACCOUNT, cleanup, mkTmp, SECRETS_TEXT, TOKEN } from './test-kit.js'
import { InstanceRefusal } from './types.js'

afterEach(cleanup)
const file = (mode: number, text = SECRETS_TEXT) => {
  const p = join(mkTmp(), 'demo.env')
  writeFileSync(p, text)
  chmodSync(p, mode)
  return p
}

describe('D10 secrets file', () => {
  it('sits beside the settings file as <env>.env', () => {
    expect(defaultSecretsPath({ XDG_CONFIG_HOME: '/x' }, '/h', 'demo')).toBe('/x/vibase/instances/demo.env')
    expect(defaultSecretsPath({}, '/h', 'demo')).toBe('/h/.config/vibase/instances/demo.env')
  })
  it('parses dotenv: comments, quotes, export, blank lines', () => {
    expect(parseDotenv(`# c\n\nA=1\nexport B="two words"\nC='x'\nD=a=b\n`)).toEqual({ A: '1', B: 'two words', C: 'x', D: 'a=b' })
  })
  it.each([0o640, 0o644, 0o604, 0o660, 0o666])('refuses mode %o, naming the path and no value', (mode) => {
    const p = file(mode)
    let msg = ''
    try { loadSecrets(p, {}) } catch (e) { expect(e).toBeInstanceOf(InstanceRefusal); msg = (e as Error).message }
    expect(msg).toContain(p)
    expect(msg).not.toContain(TOKEN)
    expect(msg).not.toContain(ACCOUNT)
  })
  it.each([0o600, 0o400])('accepts mode %o', (mode) => {
    const s = loadSecrets(file(mode), {})
    expect(s.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT)
    expect(s.CLOUDFLARE_API_TOKEN).toBe(TOKEN)
  })
  it('the process environment wins for the two CLOUDFLARE names', () => {
    const s = loadSecrets(file(0o600), { CLOUDFLARE_API_TOKEN: 'from-process-env', CLOUDFLARE_ACCOUNT_ID: 'acct-process' })
    expect(s.CLOUDFLARE_API_TOKEN).toBe('from-process-env')
    expect(s.CLOUDFLARE_ACCOUNT_ID).toBe('acct-process')
  })
  it('a missing file is a refusal naming its path, unless the process env supplies both names', () => {
    const p = join(mkTmp(), 'absent.env')
    expect(() => loadSecrets(p, {})).toThrow(p)
    expect(loadSecrets(p, { CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' }).CLOUDFLARE_API_TOKEN).toBe('t')
  })
  it('a file without a CLOUDFLARE name refuses naming the variable, not a value', () => {
    const p = file(0o600, `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`)
    expect(() => loadSecrets(p, {})).toThrow(/CLOUDFLARE_API_TOKEN/)
  })
  it('redact removes every secret value from a text', () => {
    const s = loadSecrets(file(0o600, `${SECRETS_TEXT}OTHER=hunter2hunter2\n`), {})
    const redacted = s.redact(`boom ${TOKEN} ${ACCOUNT} hunter2hunter2 end`)
    expect(redacted).not.toContain(TOKEN)
    expect(redacted).not.toContain(ACCOUNT)
    expect(redacted).not.toContain('hunter2hunter2')
    expect(redacted).toContain('boom')
  })
})
