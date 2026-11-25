// [[DX609]] group 4: the app calls the vault only through the SDK.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'test-kit.ts')
  .map((f) => ({ f, text: readFileSync(join(SRC, f), 'utf8') }))

describe('no hand-written API client remains', () => {
  it('src/api.ts does not exist', () => expect(existsSync(join(SRC, 'api.ts'))).toBe(false))
  it('no non-test source has an /api/v1/ path literal', () => {
    expect(sources.filter((s) => s.text.includes('/api/v1/')).map((s) => s.f)).toEqual([])
  })
  it('the only fetch to config.apiOrigin is discovery', () => {
    const hits = sources.flatMap(({ f, text }) =>
      text
        .split('\n')
        .filter((l) => /fetch\w*\(/.test(l) && /apiOrigin/.test(l) && !l.includes('/.well-known/vibase'))
        .map((l) => `${f}: ${l.trim()}`),
    )
    expect(hits).toEqual([])
  })
  it('the SDK client is the one place a request is built', () => {
    expect(sources.some((s) => s.text.includes("from '@vibase/sdk'"))).toBe(true)
  })
})
