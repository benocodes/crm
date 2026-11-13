// OPS276: the env block `setup:remote` writes for a new instance, put into a copy of the repo's real wrangler.jsonc, reads under wrangler's own
// reader with the vb- names, and leaves the existing env blocks (smoked1, hq) byte for byte as they were ([[OPS275]] lesson 1).
// This file lives outside scripts/setup on purpose: config-fixture.test.ts keeps the setup tests off the repo's wrangler.jsonc.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findNodeAtLocation, parseTree } from 'jsonc-parser'
import { afterAll, describe, expect, it } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { runSetup } from './setup/run.js'
import { makeWorld } from './setup/test/world.js'
import { openWorkerD1 } from '../src/test/kit.js'

const REAL = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const tmp = mkdtempSync(join(tmpdir(), 'ops276-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const blockText = (text: string, env: string): string => {
  const node = findNodeAtLocation(parseTree(text)!, ['env', env])!
  return text.slice(node.offset, node.offset + node.length)
}

describe('the written block under wrangler', () => {
  it('reads with the vb- names, and the other env blocks are unchanged', async () => {
    const db = await openWorkerD1()
    try {
      const w = makeWorld({ d1: db.d1, configText: REAL })
      const o = await runSetup(['--env', 'acme', '--auth', 'none', '--api-host', 'api.acme.vibase.ai'], { CONFIRM_REMOTE: '1' }, w.deps)
      expect(o.exitCode).toBe(0)
      const path = join(tmp, 'wrangler.jsonc')
      writeFileSync(path, w.state.configText)
      const cfg = unstable_readConfig({ config: path, env: 'acme' })
      expect(cfg.name).toBe('vb-acme')
      expect(cfg.d1_databases.find((d) => d.binding === 'DB')!.database_name).toBe('vb-crm-acme')
      expect(cfg.r2_buckets.find((b) => b.binding === 'BODIES')!.bucket_name).toBe('vb-bodies-acme')
      for (const env of ['smoked1', 'hq']) expect(blockText(w.state.configText, env)).toBe(blockText(REAL, env))
    } finally {
      await db.dispose()
    }
  })
})
