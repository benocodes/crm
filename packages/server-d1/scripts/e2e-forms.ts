// [[CHN432]] E2E, local part (432.9): a website form submitted to the real Worker under `wrangler dev --local`, with the REAL Turnstile siteverify (so it needs network access),
// the always-pass test secret and the `ratelimits` bindings of wrangler.jsonc. Everything is local and private to the run: the D1 state and the Worker's variables live in a temp directory that is removed at the end (the developer's `.wrangler/state` and `.dev.vars` are never read, changed or deleted).
//
//   pnpm -C packages/server-d1 e2e:forms
//
// Setup is the owner's, in-process on the same local state: `forms.create` is human-only and `forms:write` is not agent-grantable, so an agent cannot create the form over REST. An owner token
// (a stand-in authenticator, as the tests use) creates the tag `Leads` and the form `Contact` through the real app on the local D1; then the Worker runs and every submission and every read
// is real HTTP: the browser-style requests carry no credential, and the reads use the bootstrap agent's API key. The Worker's variables are `.dev.vars.example` plus the test secret, in a script-owned `--env-file`.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, createVibaseRegistry, ScopeSet } from '@vibase/api'
import { d1Binding, openControlDb, type D1Like } from '@vibase/storage-d1'
import { getPlatformProxy } from 'wrangler'
import { bootstrapD1 } from '../src/bootstrap-d1.js'
import { readDeployment } from '../src/init-deployment.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = join(ROOT, 'wrangler.jsonc')
const WORK = mkdtempSync(join(tmpdir(), 'vb-e2e-forms-'))
const STATE = join(WORK, 'state')
const PERSIST = join(STATE, 'v3')
const ENV_FILE = join(WORK, '.env.e2e')
const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const ORIGIN = 'https://example.com'
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'
const AGENT_SCOPES = [
  'tags:read',
  'contacts:read',
  'associations:read',
  'messages:read',
  'interactions:read',
  'forms:read',
]

type Json = Record<string, any>
let failed = 0
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
}
const run = (args: string[]): string =>
  execFileSync('pnpm', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

let server: ChildProcess | undefined
const finish = (): void => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM')
    } catch {}
  }
  rmSync(WORK, { recursive: true, force: true })
}
process.on('exit', finish)

async function main(): Promise<void> {
  // 1. A fresh local D1 pair (CRM and control) in the temp directory, migrated; the connect page built for the Worker's assets.
  mkdirSync(PERSIST, { recursive: true })
  run(['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', STATE])
  run(['exec', 'wrangler', 'd1', 'migrations', 'apply', 'CONTROL_DB', '--local', '--persist-to', STATE])
  run(['build'])
  // The Worker's variables, from a file of this script's own (wrangler ignores `.dev.vars` when `--env-file` is given).
  writeFileSync(
    ENV_FILE,
    `${readFileSync(join(ROOT, '.dev.vars.example'), 'utf8')}\nTURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA\n`,
    { mode: 0o600 },
  )

  // 2. One bootstrap, in-process on the temp state: the owner user and the read-only agent with its key.
  const proxy = await getPlatformProxy<{ DB: D1Like; CONTROL_DB: D1Like }>({
    configPath: CONFIG,
    persist: { path: PERSIST },
    remoteBindings: false,
  })
  const boot = await bootstrapD1(
    proxy.env.DB,
    {
      organizationName: 'E2E',
      authProvider: 'none',
      authOrgId: 'org_e2e',
      email: 'owner@example.com',
      agentName: 'e2e-agent',
      scopes: AGENT_SCOPES,
    },
    { control: openControlDb(proxy.env.CONTROL_DB) },
  )
  const [ownerId, organizationId, key] = [boot.userId ?? '', boot.organizationId, boot.key]
  check(
    'bootstrap: an owner, an organisation and an agent key',
    ownerId !== '' && organizationId !== '' && key.startsWith('vk_'),
  )

  // 3. The tag and the form, created by the owner through the real app on the temp state (before the Worker opens the same files).
  let publicId = ''
  let tagId = ''
  try {
    const link = (await readDeployment(proxy.env.DB))!
    const app = createApp({
      storage: () => d1Binding(proxy.env.DB, link),
      userAuthenticator: {
        authenticate: async () => ({
          actor: { id: ownerId, kind: 'user' as const },
          organizationId,
          scopes: ScopeSet.closed(createVibaseRegistry().declaredScopes()),
        }),
      },
    })
    const owner = async (path: string, body: unknown): Promise<{ status: number; json: Json }> => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { authorization: 'Bearer e30.e30.x', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, json: (await res.json()) as Json }
    }
    const tag = await owner('/api/v1/tags', { name: 'Leads' })
    tagId = tag.json.id
    check('owner creates the tag Leads', tag.status === 201 && tagId !== undefined, tag)
    const form = await owner('/meta/v1/forms', {
      name: 'Contact',
      email_field: 'email',
      name_field: 'name',
      consent_text: 'I agree to be contacted.',
      allowed_origins: [ORIGIN],
      tag_ids: [tagId],
    })
    publicId = form.json.public_id
    check(
      'owner creates the form Contact with its public id',
      form.status === 201 && /^frm_/.test(publicId ?? ''),
      form,
    )
  } finally {
    await proxy.dispose()
  }

  // 4. The Worker.
  server = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--local',
      '--port',
      String(PORT),
      '--ip',
      '127.0.0.1',
      '--persist-to',
      STATE,
      '--env-file',
      ENV_FILE,
    ],
    {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  server.stdout?.on('data', (c) => (log += c))
  server.stderr?.on('data', (c) => (log += c))
  for (let i = 0; i < 120; i++) {
    if (
      await fetch(`${BASE}/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break
    await new Promise((r) => setTimeout(r, 1000))
    if (i === 119) throw new Error(`the Worker did not come up:\n${log.slice(-2000)}`)
  }

  const agent = async (path: string): Promise<Json> =>
    (await (await fetch(BASE + path, { headers: { authorization: `Bearer ${key}` } })).json()) as Json
  const counts = async () => ({
    contacts: (await agent('/api/v1/contacts')).data?.length ?? -1,
    threads: (await agent('/api/v1/threads')).data?.length ?? -1,
    messages: (await agent('/api/v1/messages')).data?.length ?? -1,
    interactions: (await agent('/api/v1/interactions')).data?.length ?? -1,
  })
  const submit = (
    path: string,
    o: {
      ip: string
      origin?: string
      type?: 'urlencoded' | 'json'
      fields?: Record<string, string>
      token?: string | null
    },
  ): Promise<Response> => {
    const fields: Record<string, string> = { ...(o.fields ?? {}) }
    if (o.token !== null) fields['cf-turnstile-response'] = o.token ?? TOKEN
    const json = o.type === 'json'
    return fetch(BASE + path, {
      method: 'POST',
      headers: {
        origin: o.origin ?? ORIGIN,
        'cf-connecting-ip': o.ip,
        'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
      },
      body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    })
  }
  const code = async (res: Response): Promise<string | undefined> =>
    (
      (await res
        .clone()
        .json()
        .catch(() => ({}))) as Json
    ).error?.code
  const path = `/f/${publicId}`
  const ADA = { name: 'Ada', email: 'ada@example.com', message: 'Hi', _vb_consent: 'on' }

  // 1. The preflight.
  const pre = await fetch(BASE + path, {
    method: 'OPTIONS',
    headers: { origin: ORIGIN, 'cf-connecting-ip': '192.0.2.1' },
  })
  check(
    '1 OPTIONS: 204 with the allowed origin',
    pre.status === 204 && pre.headers.get('access-control-allow-origin') === ORIGIN,
    pre.status,
  )
  // 2, 3. Two accepted submissions, urlencoded then JSON, from the same address.
  const first = await submit(path, { ip: '192.0.2.2', fields: ADA })
  check(
    '2 urlencoded POST: 202 {"status":"received"}',
    first.status === 202 && ((await first.json()) as Json).status === 'received',
    first.status,
  )
  const second = await submit(path, { ip: '192.0.2.2', type: 'json', fields: { ...ADA, message: 'Hi again' } })
  check(
    '3 JSON POST: 202 {"status":"received"}',
    second.status === 202 && ((await second.json()) as Json).status === 'received',
    second.status,
  )

  const after = await counts()
  check(
    '2-3 one contact, one thread, two messages, two interactions',
    after.contacts === 1 && after.threads === 1 && after.messages === 2 && after.interactions === 2,
    after,
  )
  const contacts = (await agent('/api/v1/contacts')).data as Json[]
  check('2-3 the contact is Ada', contacts[0]?.name === 'Ada', contacts[0])
  const taggedAnswer = await agent(`/api/v1/contacts?tag_id=${tagId}`)
  const tagged = (taggedAnswer.data as Json[] | undefined) ?? []
  check('2-3 Leads is linked to Ada', tagged.length === 1 && tagged[0]?.id === contacts[0]?.id, taggedAnswer)
  const threads = (await agent('/api/v1/threads')).data as Json[]
  check('2-3 the thread is on channel form', threads[0]?.channel === 'form', threads[0])
  const interactions = (await agent('/api/v1/interactions')).data as Json[]
  check(
    '2-3 both interactions are inbound on form',
    interactions.length === 2 && interactions.every((i) => i.channel === 'form' && i.direction === 'inbound'),
    interactions,
  )
  const messages = ((await agent('/api/v1/messages')).data as Json[]).sort((a, b) =>
    String(a.occurred_at).localeCompare(String(b.occurred_at)),
  )
  const content = (await agent(`/api/v1/messages/${messages[0]?.id}/content`)).content as string
  check(
    '2-3 the first message shows the answers and the consent section',
    /Ada/.test(content) && /ada\\?@example\.com/.test(content) && /Hi/.test(content) && /[Cc]onsent/.test(content),
    content.slice(0, 300),
  )
  check(
    '2-3 no reserved field in the content',
    !/cf-turnstile-response|_vb_|XXXX\.DUMMY/.test(content),
    content.slice(0, 300),
  )

  // 4-7. Refusals and the uniform 202, each leaving the counts as they were.
  const evil = await submit(path, { ip: '192.0.2.3', origin: 'https://evil.example', fields: ADA })
  check(
    '4 another origin: 403 origin_not_allowed',
    evil.status === 403 && (await code(evil)) === 'origin_not_allowed',
    evil.status,
  )
  const noToken = await submit(path, { ip: '192.0.2.4', fields: ADA, token: null })
  check(
    '5 no token: 403 challenge_failed',
    noToken.status === 403 && (await code(noToken)) === 'challenge_failed',
    noToken.status,
  )
  const bot = await submit(path, { ip: '192.0.2.5', fields: { ...ADA, email: 'bot@example.com', _vb_hp: 'x' } })
  check('6 honeypot: 202', bot.status === 202, bot.status)
  const missing = await submit('/f/does-not-exist', { ip: '192.0.2.6', fields: ADA })
  check(
    '7 unknown form: 404 not_found',
    missing.status === 404 && (await code(missing)) === 'not_found',
    missing.status,
  )
  check('4-7 the counts are unchanged', JSON.stringify(await counts()) === JSON.stringify(after), await counts())

  // 8. Eleven POSTs from one new IP: the 11th is limited by the real `ratelimits` binding.
  const answers: number[] = []
  let last: Response | undefined
  for (let i = 0; i < 11; i++) {
    last = await submit(path, { ip: '192.0.2.77', fields: { ...ADA, email: 'bot@example.com', _vb_hp: 'x' } })
    answers.push(last.status)
  }
  check(
    '8 the 11th POST from one IP: 429 with Retry-After: 60',
    answers.slice(0, 10).every((s) => s === 202) && answers[10] === 429 && last?.headers.get('retry-after') === '60',
    answers,
  )
  check('8 and still no new record', JSON.stringify(await counts()) === JSON.stringify(after), await counts())
}

try {
  await main()
} catch (err) {
  failed++
  console.log(`FAIL e2e aborted -> ${err instanceof Error ? err.message : String(err)}`)
} finally {
  finish()
}
console.log(failed === 0 ? 'e2e:forms passed' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
