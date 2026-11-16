// UI255 D6 (group 5) on `setup:remote`: `AUTH_TRUSTED_ORIGINS` is an operator-owned var. A re-run over a record that holds it leaves it unchanged; a fresh instance writes nothing for it and never prompts.
import { readFileSync } from 'node:fs'
import { applyEdits, modify, parse } from 'jsonc-parser'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { runSetup } from './run.js'
import { FIXTURE_CONFIG_PATH, makeWorld, type World } from './test/world.js'

const CONFIRM = { CONFIRM_REMOTE: '1' }
const HOST = 'api.acme.vibase.ai'
const ACME = ['--env', 'acme', '--api-host', HOST, '--owner-email', 'owner@example.com']
const fixture = readFileSync(FIXTURE_CONFIG_PATH, 'utf8')
const TRUSTED = 'https://app.acme.vibase.ai'

let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(() => pair.dispose())
beforeEach(() => pair.reset())

const world = (configText?: string): World =>
  makeWorld({ d1: pair.d1, control: pair.control, clerkEnvText: null, ...(configText ? { configText } : {}) })
const varsOf = (w: World) =>
  (parse(w.state.configText) as { env: Record<string, { vars: Record<string, string> }> }).env.acme!.vars

describe('setup:remote and AUTH_TRUSTED_ORIGINS', () => {
  it('a re-run over a record that holds it keeps it unchanged', async () => {
    const vars = {
      AUTH_PROVIDER: 'better-auth',
      PUBLIC_BASE_URL: `https://${HOST}`,
      CORS_ALLOWED_ORIGINS: '',
      AUTH_TRUSTED_ORIGINS: TRUSTED,
    }
    const text = applyEdits(
      fixture,
      modify(
        fixture,
        ['env', 'acme'],
        { name: 'vb-acme', vars },
        { formattingOptions: { insertSpaces: true, tabSize: 2 } },
      ),
    )
    const w = world(text)
    const o = await runSetup(ACME, CONFIRM, w.deps) // completes the record's env block
    expect(o.stoppedAfterConfigWrite, w.logs.join('\n')).toBe(true)
    expect(varsOf(w).AUTH_TRUSTED_ORIGINS).toBe(TRUSTED)
    expect(varsOf(w).AUTH_TRUSTED_ORIGINS).toBe(TRUSTED)
    expect(w.logs.join('\n')).not.toMatch(/AUTH_TRUSTED_ORIGINS/)
  })

  it('a fresh instance writes nothing for it', async () => {
    const w = world()
    await runSetup(ACME, CONFIRM, w.deps)
    expect(varsOf(w)).not.toHaveProperty('AUTH_TRUSTED_ORIGINS')
    expect(w.logs.join('\n')).not.toMatch(/AUTH_TRUSTED_ORIGINS/)
  })
})
