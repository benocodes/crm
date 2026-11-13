import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { AUTH_TABLES } from '@vibase/auth'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS } from '@vibase/storage-d1'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker } from './compose.js'
import { NOW, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE243]] D5: the auth tables are machinery. They live in the control-plane database (control 0001; the CRM copy of 0018 is dropped by 0019, [[OPS260]]), and nothing the vault shows or does knows them.
let w: WorkerPair
beforeAll(async () => {
  w = await openWorkerPair()
})
afterAll(() => w.dispose())

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url))
function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.ts$/.test(name) && !/\.(test|suite|typecheck)\.ts$/.test(name) && !/[\\/]test[\\/]/.test(path)) yield path
  }
}

describe('the auth tables are machinery (D5)', () => {
  it('they exist in the control database and not in the CRM database (so the checks below are not vacuous)', async () => {
    const authIn = async (db: typeof w.d1) => ((await db.prepare("select name from sqlite_master where type = 'table' and name like 'auth\\_%' escape '\\'").all()).results as Array<{ name: string }>).map((r) => r.name)
    expect(AUTH_TABLES.length).toBeGreaterThanOrEqual(13)
    expect((await authIn(w.control)).sort()).toEqual([...AUTH_TABLES].sort())
    expect(await authIn(w.d1)).toEqual([])
  })

  it('GET /meta/v1/schema lists no auth_ table, and mentions none anywhere in the document', async () => {
    const { key } = await bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme' }, { now: NOW, newId: () => uuidv7(NOW) })
    await createMigrationTracker(w.d1)
    await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name))
    const res = await composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '' }).fetch(new Request('https://w.test/meta/v1/schema', { headers: { authorization: `Bearer ${key}` } }))
    expect(res.status).toBe(200)
    const text = await res.text()
    const doc = JSON.parse(text) as { tables: Array<{ name: string }> }
    expect(doc.tables.length).toBeGreaterThan(10)
    expect(doc.tables.filter((t) => t.name.startsWith('auth_'))).toEqual([])
    for (const table of AUTH_TABLES) expect(text, table).not.toContain(table)
  })

  it('no vault production source (api, storage, storage-d1, server-d1) names an auth table: no operation reads or writes one', () => {
    expect(AUTH_TABLES.length).toBeGreaterThanOrEqual(13)
    const offenders: string[] = []
    for (const pkg of ['api/src', 'storage/src', 'storage-d1/src', 'server-d1/src']) {
      for (const file of sources(join(PACKAGES, pkg))) {
        const text = readFileSync(file, 'utf8')
        for (const table of AUTH_TABLES) if (text.includes(table)) offenders.push(`${file.slice(PACKAGES.length)} names ${table}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
