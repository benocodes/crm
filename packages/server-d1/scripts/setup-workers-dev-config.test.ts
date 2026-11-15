// OPS308 obligation 3 (the [[CORE259]] lesson): the env block `setup:remote` writes in `--workers-dev` mode, put into a copy of the repo's real wrangler.jsonc, reads under wrangler's OWN
// reader (not the kit's) with `workers_dev` true and no routes; the move to a custom domain keeps `workers_dev` and adds the route. Outside scripts/setup on purpose, as OPS279's twin:
// config-fixture.test.ts keeps the setup tests off the repo's wrangler.jsonc.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { openWorkerD1 } from '../src/test/kit.js'
import { runSetup } from './setup/run.js'
import { makeWorld } from './setup/test/world.js'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const REAL = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const COPY = resolve(PACKAGE, `wrangler.ops308-${process.pid}.jsonc`)
afterAll(() => rmSync(COPY, { force: true }))

describe('the written workers.dev block under wrangler', () => {
  it('reads as workers_dev true with no routes; after --change-host it keeps workers_dev and gains the custom_domain route', async () => {
    const db = await openWorkerD1()
    try {
      const w = makeWorld({ d1: db.d1, configText: REAL })
      const o = await runSetup(['--env', 'acme', '--auth', 'none', '--workers-dev'], { CONFIRM_REMOTE: '1' }, w.deps)
      expect(o.exitCode, w.logs.join('\n')).toBe(0)
      writeFileSync(COPY, w.state.configText)
      const cfg = unstable_readConfig({ config: COPY, env: 'acme' })
      expect(cfg.workers_dev).toBe(true)
      expect(cfg.routes ?? []).toEqual([])
      expect(cfg.name).toBe('vb-acme')

      const moved = await runSetup(['--env', 'acme', '--auth', 'none', '--api-host', 'api.acme.vibase.ai', '--change-host'], { CONFIRM_REMOTE: '1' }, w.deps)
      expect(moved.exitCode, w.logs.join('\n')).toBe(0)
      writeFileSync(COPY, w.state.configText)
      const after = unstable_readConfig({ config: COPY, env: 'acme' })
      expect(after.workers_dev).toBe(true)
      expect(after.routes).toEqual([{ pattern: 'api.acme.vibase.ai', custom_domain: true }])
    } finally {
      await db.dispose()
    }
  })
})
