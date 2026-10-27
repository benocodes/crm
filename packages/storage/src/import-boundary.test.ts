import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkBoundary, RULES } from './test/boundary.js'

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url))

describe('import boundary (D14, D15)', () => {
  it('the repository passes: open packages import nothing enterprise, and the api rules have no allow-list', () => {
    expect(checkBoundary(PACKAGES)).toEqual([])
  })

  const sandbox = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'boundary-'))
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    return root
  }

  it.each([
    ['the core importing pg', { 'storage/src/a.ts': "import pg from 'pg'" }, 'pg'],
    ['the core importing the Postgres runtime', { 'storage/src/a.ts': "export * from '@vault/storage-postgres'" }, '@vault/storage-postgres'],
    ['the core importing a runtime', { 'storage/src/a.ts': "import { d1Binding } from '@vault/storage-d1'" }, '@vault/storage-d1'],
    ['the core importing @vault/db', { 'storage/src/a.ts': "import { x } from '@vault/db/test'" }, '@vault/db/test'],
    ['the D1 runtime importing pg', { 'storage-d1/src/a.ts': "const pg = await import('pg')" }, 'pg'],
    ['the D1 runtime importing the API barrel', { 'storage-d1/src/a.ts': "import { createApp } from '@vault/api'" }, '@vault/api'],
    ['the D1 runtime importing the Postgres runtime', { 'storage-d1/src/a.ts': "import { postgresBinding } from '@vault/storage-postgres'" }, '@vault/storage-postgres'],
    ['an API script importing the Postgres runtime', { 'api/scripts/smoke-auth.ts': "import { postgresBinding } from '@vault/storage-postgres'" }, '@vault/storage-postgres'],
    ['the dev server in the API', { 'api/src/dev-server.ts': "import { postgresBinding } from '@vault/storage-postgres'" }, '@vault/storage-postgres'],
    ['an API source importing the Postgres runtime', { 'api/src/a.ts': "import { postgresBinding } from '@vault/storage-postgres'" }, '@vault/storage-postgres'],
    ['an API source importing @vault/db', { 'api/src/a.ts': "import type { Database } from '@vault/db'" }, '@vault/db'],
    ['an API source importing the server package', { 'api/src/a.ts': "import '@vault/server-postgres'" }, '@vault/server-postgres'],
    ['the D1 server importing the Postgres runtime', { 'server-d1/src/a.ts': "import { postgresBinding } from '@vault/storage-postgres'" }, '@vault/storage-postgres'],
    ['a D1 server script importing @vault/db', { 'server-d1/scripts/x.ts': "import { createDb } from '@vault/db'" }, '@vault/db'],
    ['the D1 runtime importing the server package', { 'storage-d1/src/a.ts': "import '@vault/server-postgres'" }, '@vault/server-postgres'],
  ])('fails on %s', (_name, files, specifier) => {
    expect(checkBoundary(sandbox(files)).map((v) => v.specifier)).toEqual([specifier])
  })

  it('the composition rules have no allow-list', () => {
    const composition = RULES.filter((r) => r.dir.startsWith('api/') || r.dir.startsWith('server-d1/'))
    expect(composition.map((r) => r.dir)).toEqual(['api/src', 'api/scripts', 'server-d1/src', 'server-d1/scripts'])
    for (const r of composition) expect(r.allow).toBeUndefined()
  })

  it('allows the D1 server to import the API', () => {
    expect(checkBoundary(sandbox({ 'server-d1/src/a.ts': "import { createApp } from '@vault/api'" }))).toEqual([])
  })

  it('allows what is allowed: API tests and the core kysely import', () => {
    const root = sandbox({
      'api/src/x.integration.test.ts': "import { postgresBinding } from '@vault/storage-postgres'",
      'storage/src/ok.ts': "import { Kysely } from 'kysely'",
    })
    expect(checkBoundary(root)).toEqual([])
  })
})
