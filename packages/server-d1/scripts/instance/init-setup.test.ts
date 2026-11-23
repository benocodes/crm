// [[OPS494]] D4, D6: a file `init` writes is read by setup's own loaders (the round trip), and a Gmail group without the Google client is off, not refused.
// The `setup:remote` front-end's case of D6 is in `../setup/gmail.test.ts`.
import { writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { runInit } from './init.js'
import { API_HOST, GMAIL_CREDENTIALS_KEY, NONE_ARGS, setupWorld } from './setup-kit.js'
import { loadSecrets } from './secrets.js'
import { runSetup } from './setup.js'
import { ACCOUNT, SECRETS_TEXT, TOKEN, cleanup, makeWorld } from './test-kit.js'

const OWNER = 'owner@example.com'

let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(async () => {
  await pair.dispose()
})
beforeEach(async () => {
  await pair.reset()
})
afterEach(() => cleanup())

const world = (secretsText: string) => setupWorld({ d1: pair, control: pair.control, secretsText })
const initFile = async (flags: string[]) => {
  const w = makeWorld({ settings: null, secretsMode: null })
  expect(await runInit(['--env', 'demo', '--api-host', API_HOST, ...flags, '--yes'], w.deps), w.all()).toBe(0)
  const { readFileSync } = await import('node:fs')
  const next = w.out
    .find((l) => l.trim().startsWith('vibase-server setup'))!
    .trim()
    .split(' ')
    .slice(2)
  return {
    text: readFileSync(w.secretsPath, 'utf8'),
    path: w.secretsPath,
    next,
    settingsText: readFileSync(w.settingsPath, 'utf8'),
  }
}
const fillCloudflare = (t: string) =>
  t
    .replace('CLOUDFLARE_ACCOUNT_ID=\n', `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`)
    .replace('CLOUDFLARE_API_TOKEN=\n', `CLOUDFLARE_API_TOKEN=${TOKEN}\n`)
const GOOGLE_OFF =
  /gmail: off \(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .*demo\.env\): add them and re-run setup/

describe('round trip: the file init wrote, read by setup', () => {
  // setup runs with the words of the command init printed, so a flag the command lacks shows here.
  it.each([
    ['better-auth + gmail', ['--owner-email', OWNER, '--auth', 'better-auth']],
    ['clerk + gmail', ['--owner-email', OWNER, '--auth', 'clerk']],
    ['none + none', ['--auth', 'none', '--email', 'none']],
  ])('%s', async (name, initFlags) => {
    const { text, path, next, settingsText } = await initFile(initFlags)
    // the printed words, as they are, plus the one flag the test adds so nothing is written
    expect(next, name).toEqual(['--env', 'demo'])
    const setupArgs = [...next, '--dry-run']
    // empty Cloudflare values count as unset
    expect(() => loadSecrets(path, {}), name).toThrow(/CLOUDFLARE_ACCOUNT_ID/)
    const s = world(fillCloudflare(text))
    writeFileSync(s.w.settingsPath, settingsText)
    const code = await runSetup(setupArgs, s.w.deps)
    const said = s.w.all()
    if (name.startsWith('clerk')) {
      expect(code, said).toBe(2)
      expect(s.w.err.join('\n')).toContain('CLERK_SECRET_KEY')
      return
    }
    expect(code, said).toBe(0)
    expect(said).toMatch(GOOGLE_OFF)
    expect(said).toContain(`api host ${API_HOST}`)
    expect(said).toContain(`auth ${initFlags[initFlags.indexOf('--auth') + 1]}`)
    if (name.startsWith('better-auth')) {
      expect(said).toMatch(/better-auth: .*AUTH_SECRET from .*demo\.env/)
      expect(s.settings()).toBe(settingsText) // a dry run leaves init's file alone
    }
  })
})

describe('D6: the Google client turns Gmail on (vibase-server setup)', () => {
  const keys = `${SECRETS_TEXT}OAUTH_STATE_SECRET=state-0123456789\nCREDENTIALS_KEY=${GMAIL_CREDENTIALS_KEY}\n`
  it('the two keys without a client: off line naming the file, no refusal, nothing of the group written', async () => {
    const s = world(keys)
    expect(await runSetup(NONE_ARGS, s.w.deps), s.w.all()).toBe(0)
    expect(s.w.out.join('\n')).toMatch(GOOGLE_OFF)
    for (const c of s.w.wrangler) expect(c.input ?? '').not.toMatch(/OAUTH_STATE_SECRET|CREDENTIALS_KEY/)
    expect(s.settings() ?? '').not.toMatch(/GOOGLE_CLIENT_ID|GMAIL_|PUBLIC_BASE_URL/)
  })
  it('only GOOGLE_CLIENT_ID set (half-entered) still refuses, naming the missing values', async () => {
    const s = world(`${keys}GOOGLE_CLIENT_ID=gid-1.apps.googleusercontent.com\n`)
    expect(await runSetup([...NONE_ARGS, '--dry-run'], s.w.deps)).toBe(2)
    expect(s.w.err.join('\n')).toContain('GOOGLE_CLIENT_SECRET')
  })
  it('all four set behaves as today', async () => {
    const s = world(
      `${keys}GOOGLE_CLIENT_ID=gid-1.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=gsecret-0123456789\n`,
    )
    expect(await runSetup([...NONE_ARGS, '--dry-run'], s.w.deps), s.w.all()).toBe(0)
    expect(s.w.out.join('\n')).toMatch(/gmail: on, from /)
  })
})
