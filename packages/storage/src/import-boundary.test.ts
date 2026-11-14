import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkBoundary, checkEngineNaming, RULES } from './test/boundary.js'

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
    ['the core importing the Postgres runtime', { 'storage/src/a.ts': "export * from '@vibase/storage-postgres'" }, '@vibase/storage-postgres'],
    ['the core importing a runtime', { 'storage/src/a.ts': "import { d1Binding } from '@vibase/storage-d1'" }, '@vibase/storage-d1'],
    ['the core importing @vibase/db', { 'storage/src/a.ts': "import { x } from '@vibase/db/test'" }, '@vibase/db/test'],
    ['the D1 runtime importing pg', { 'storage-d1/src/a.ts': "const pg = await import('pg')" }, 'pg'],
    ['the D1 runtime importing the API barrel', { 'storage-d1/src/a.ts': "import { createApp } from '@vibase/api'" }, '@vibase/api'],
    ['the D1 runtime importing the Postgres runtime', { 'storage-d1/src/a.ts': "import { postgresBinding } from '@vibase/storage-postgres'" }, '@vibase/storage-postgres'],
    ['an API script importing the Postgres runtime', { 'api/scripts/smoke-auth.ts': "import { postgresBinding } from '@vibase/storage-postgres'" }, '@vibase/storage-postgres'],
    ['the dev server in the API', { 'api/src/dev-server.ts': "import { postgresBinding } from '@vibase/storage-postgres'" }, '@vibase/storage-postgres'],
    ['an API source importing the Postgres runtime', { 'api/src/a.ts': "import { postgresBinding } from '@vibase/storage-postgres'" }, '@vibase/storage-postgres'],
    ['an API source importing @vibase/db', { 'api/src/a.ts': "import type { Database } from '@vibase/db'" }, '@vibase/db'],
    ['an API source importing the server package', { 'api/src/a.ts': "import '@vibase/server-postgres'" }, '@vibase/server-postgres'],
    ['the D1 server importing the Postgres runtime', { 'server-d1/src/a.ts': "import { postgresBinding } from '@vibase/storage-postgres'" }, '@vibase/storage-postgres'],
    ['a D1 server script importing @vibase/db', { 'server-d1/scripts/x.ts': "import { createDb } from '@vibase/db'" }, '@vibase/db'],
    ['the D1 runtime importing the server package', { 'storage-d1/src/a.ts': "import '@vibase/server-postgres'" }, '@vibase/server-postgres'],
    ['the auth package importing pg ([[CORE243]] D21)', { 'auth/src/a.ts': "import pg from 'pg'" }, 'pg'],
    ['the auth package importing the Postgres runtime', { 'auth/src/a.ts': "import { postgresBinding } from '@vibase/storage-postgres'" }, '@vibase/storage-postgres'],
    ['the UI layer importing pg in a .tsx file ([[UI254]] D8)', { 'ui/src/a.tsx': "import pg from 'pg'\nexport const A = () => null" }, 'pg'],
    ['the UI layer importing the Postgres runtime', { 'ui/src/a.ts': "import { postgresBinding } from '@vibase/storage-postgres'" }, '@vibase/storage-postgres'],
    ['an auth script importing @vibase/db', { 'auth/scripts/x.ts': "import { createDb } from '@vibase/db'" }, '@vibase/db'],
  ])('fails on %s', (_name, files, specifier) => {
    expect(checkBoundary(sandbox(files)).map((v) => v.specifier)).toEqual([specifier])
  })

  it('the composition rules have no allow-list', () => {
    const composition = RULES.filter((r) => r.dir.startsWith('api/') || r.dir.startsWith('server-d1/'))
    expect(composition.map((r) => r.dir)).toEqual(['api/src', 'api/scripts', 'server-d1/src', 'server-d1/scripts'])
    for (const r of composition) expect(r.allow).toBeUndefined()
  })

  it('the UI rule skips test files, which are .tsx too', () => {
    expect(checkBoundary(sandbox({ 'ui/src/a.ui.test.tsx': "import pg from 'pg'", 'ui/src/b.test.tsx': "import pg from 'pg'" }))).toEqual([])
  })

  it('allows the D1 server to import the API', () => {
    expect(checkBoundary(sandbox({ 'server-d1/src/a.ts': "import { createApp } from '@vibase/api'" }))).toEqual([])
  })

  it('allows what is allowed: API tests and the core kysely import', () => {
    const root = sandbox({
      'api/src/x.integration.test.ts': "import { postgresBinding } from '@vibase/storage-postgres'",
      'storage/src/ok.ts': "import { Kysely } from 'kysely'",
    })
    expect(checkBoundary(root)).toEqual([])
  })
})

// OPS92 D2: the engine is in the file name. A `*.test.ts` with no `.postgres.` infix (engine-neutral or `.d1.`) runs in the
// default projects and must not need a Postgres database, so it must not import the Postgres helpers or runtime.
describe('engine naming (OPS92 D2)', () => {
  const sandbox = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'naming-'))
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    return root
  }

  it('the repository passes: no test without the postgres infix imports Postgres code', () => {
    expect(checkEngineNaming(PACKAGES)).toEqual([])
  })

  it.each([
    ['an engine-neutral test importing the Postgres test helpers', { 'api/src/a.test.ts': "import { createTestDb } from '@vibase/db/test'" }, '@vibase/db/test'],
    ['an integration test importing the Postgres runtime', { 'api/src/a.integration.test.ts': "import { postgresBinding } from '@vibase/storage-postgres'" }, '@vibase/storage-postgres'],
    ['a d1 test importing @vibase/db', { 'api/src/a.d1.test.ts': "import { withServiceRole } from '@vibase/db'" }, '@vibase/db'],
    ['a .test.tsx importing the Postgres test helpers', { 'ui/src/a.test.tsx': "import { createTestDb } from '@vibase/db/test'" }, '@vibase/db/test'],
    ['a test importing pg lazily', { 'storage-d1/src/a.test.ts': "const pg = await import('pg')" }, 'pg'],
    ['an integration test in a Postgres package without the infix, whatever it imports', { 'db/src/test/a.integration.test.ts': "import { createTestDb } from './db.js'" }, '<integration test in a Postgres package>'],
  ])('fails on %s', (_name, files, specifier) => {
    expect(checkEngineNaming(sandbox(files)).map((v) => v.specifier)).toEqual([specifier])
  })

  it('allows what is allowed: the postgres infix, type-only imports, and non-test helpers', () => {
    const root = sandbox({
      'api/src/a.integration.postgres.test.ts': "import { createTestDb } from '@vibase/db/test'",
      'api/src/b.test.ts': "import type { Database } from '@vibase/db'\nimport type {\n  A,\n} from '@vibase/storage-postgres'",
      'api/src/test/helper.ts': "import { createTestDb } from '@vibase/db/test'",
    })
    expect(checkEngineNaming(root)).toEqual([])
  })
})
