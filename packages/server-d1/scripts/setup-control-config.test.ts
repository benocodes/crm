// OPS279: the env block `setup:remote` writes for a new instance, put into a copy of the repo's real wrangler.jsonc, reads under wrangler's own reader with
// DB and CONTROL_DB (distinct names and ids, CONTROL_DB's migrations directory the shipped control migrations), and the existing blocks stay byte for byte.
// This file lives outside scripts/setup on purpose: config-fixture.test.ts keeps the setup tests off the repo's wrangler.jsonc.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findNodeAtLocation, parseTree } from 'jsonc-parser'
import { afterAll, describe, expect, it } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { openWorkerD1 } from '../src/test/kit.js'
import { runSetup } from './setup/run.js'
import { makeWorld } from './setup/test/world.js'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const REAL = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
// A copy next to the real config, so the relative `migrations_dir` resolves exactly as it would for the real file.
const COPY = resolve(PACKAGE, `wrangler.ops279-${process.pid}.jsonc`)
afterAll(() => rmSync(COPY, { force: true }))
const blockText = (text: string, env: string): string => {
  const node = findNodeAtLocation(parseTree(text)!, ['env', env])!
  return text.slice(node.offset, node.offset + node.length)
}

describe('the written block under wrangler', () => {
  it('has DB and CONTROL_DB with distinct names and ids, the shipped control migrations, and leaves smoked1 and hq byte for byte', async () => {
    const db = await openWorkerD1()
    try {
      const w = makeWorld({ d1: db.d1, configText: REAL })
      const o = await runSetup(['--env', 'acme', '--auth', 'none', '--api-host', 'api.acme.vibase.ai'], { CONFIRM_REMOTE: '1' }, w.deps)
      expect(o.exitCode).toBe(0)
      writeFileSync(COPY, w.state.configText)
      const cfg = unstable_readConfig({ config: COPY, env: 'acme' })
      const by = (b: string) => cfg.d1_databases.find((d: { binding: string }) => d.binding === b)
      expect(by('DB')).toMatchObject({ database_name: 'vb-crm-acme' })
      expect(by('CONTROL_DB')).toMatchObject({ database_name: 'vb-control-acme' })
      expect(by('CONTROL_DB').database_name).not.toBe(by('DB').database_name)
      expect(by('CONTROL_DB').database_id).not.toBe(by('DB').database_id)
      for (const d of [by('DB'), by('CONTROL_DB')]) expect(d.database_id).toMatch(/^[0-9a-f-]{36}$/)
      expect(by('CONTROL_DB').database_id).not.toBe('00000000-0000-0000-0000-000000000001')
      const dir = resolve(PACKAGE, '../storage-d1/control-migrations')
      expect(resolve(PACKAGE, by('CONTROL_DB').migrations_dir)).toBe(dir)
      expect(existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.sql'))).toBe(true)
      expect(resolve(PACKAGE, by('DB').migrations_dir)).toBe(resolve(PACKAGE, '../storage-d1/migrations'))
      for (const env of ['smoked1', 'hq']) expect(blockText(w.state.configText, env)).toBe(blockText(REAL, env))
    } finally {
      await db.dispose()
    }
  })
})
