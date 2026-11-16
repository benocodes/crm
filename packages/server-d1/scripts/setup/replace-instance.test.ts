// OPS250 (D11, D12): `setup:remote --replace-instance <env>` builds a fresh Better Auth instance on the `vb-` names in place of a recorded one and touches nothing old.
// Everything runs against the setup kit's faked wrangler / Cloudflare / files with two real local D1s behind the proxy, on the `smoked1`-shaped fixture block
// (`vault-*` names, `AUTH_PROVIDER` empty, no control database). The real wrangler.jsonc is never read.
import { readFileSync } from 'node:fs'
import { applyEdits, modify, parse, parseTree, findNodeAtLocation } from 'jsonc-parser'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { requireControlTarget, resolveTarget } from '../remote.js'
import { runSetup } from './run.js'
import { FIXTURE_CONFIG_PATH, makeWorld, type World, type WorldOptions } from './test/world.js'

const CONFIRM = { CONFIRM_REMOTE: '1' }
const HOST = 'api.smoked1.vibase.ai'
const OWNER = 'owner@example.com'
const BASE = ['--env', 'smoked1', '--api-host', HOST, '--owner-email', OWNER]
const REPLACE = [...BASE, '--replace-instance', 'smoked1']
const fixture0 = readFileSync(FIXTURE_CONFIG_PATH, 'utf8')
const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
/** The fixture plus a second env block after `smoked1`, so "every other block byte for byte" has something to hold. */
const withOther = applyEdits(
  fixture0,
  modify(fixture0, ['env', 'other'], { name: 'vault-other', vars: { AUTH_PROVIDER: '' } }, fmt),
)
/** The real smoked1 block carries a hand-added MAIL_SYNC workflow; the shared fixture does not, so it is added here (OPS250 review, 250.19). */
const fixture = applyEdits(
  withOther,
  modify(
    withOther,
    ['env', 'smoked1', 'workflows'],
    [{ binding: 'MAIL_SYNC', name: 'vault-smoked1-mail-sync', class_name: 'MailSyncWorkflow' }],
    fmt,
  ),
)
const withControl = applyEdits(
  fixture,
  modify(
    fixture,
    ['env', 'smoked1', 'd1_databases', 1],
    { binding: 'CONTROL_DB', database_name: 'vault-control-smoked1', database_id: 'c1', remote: true },
    { ...fmt, isArrayInsertion: true },
  ),
)
const sameWorkflow = applyEdits(
  fixture,
  modify(fixture, ['env', 'smoked1', 'workflows', 0, 'name'], 'vb-mail-sync-smoked1', fmt),
)
const OLD = {
  worker: 'vault-smoked1',
  d1: 'vault-smoked1',
  r2: 'vault-smoked1-bodies',
  workflow: 'vault-smoked1-mail-sync',
  id: '13f7fb64-d909-44e7-9ce7-cc3c753bb3bc',
}
const oldCloud = { d1s: [{ uuid: OLD.id, name: OLD.d1 }], r2s: [OLD.r2] }

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

const world = (o: Partial<WorldOptions> = {}): World =>
  makeWorld({ d1: pair.d1, control: pair.control, clerkEnvText: null, configText: fixture, ...oldCloud, ...o })
const run = (w: World, argv: string[]) => runSetup(argv, CONFIRM, w.deps)
const dry = (w: World, argv: string[]) => runSetup([...argv, '--dry-run'], {}, w.deps)
const rows = async (d1: WorkerPair['d1'], q: string) =>
  ((await d1.prepare(q).all()).results ?? []) as Record<string, any>[]
const step = (o: Awaited<ReturnType<typeof runSetup>>, name: string) => o.results.find((r) => r.step === name)!
const said = (w: World) => w.logs.join('\n')
const block = (text: string, env = 'smoked1') => (parse(text) as { env: Record<string, any> }).env[env]
/** Fails a wrangler command the test names: it is recorded in argv but has no effect, and exits 1. */
function failWhen(w: World, pred: (args: string[]) => boolean): void {
  const orig = w.deps.exec
  w.deps.exec = async (cmd) =>
    pred(cmd.args)
      ? (w.argv.push([cmd.command, ...cmd.args]), { status: 1, stdout: '', stderr: 'injected' })
      : orig(cmd)
}

describe('1. refusals before any call (matrix)', () => {
  const FILE_SECRET = `AUTH_SECRET=${'A'.repeat(43)}\n`
  const CASES: [string, string[], Partial<WorldOptions>, RegExp][] = [
    [
      'value differs from --env',
      [...BASE, '--replace-instance', 'acme'],
      {},
      /--replace-instance acme.*must equal --env smoked1/,
    ],
    [
      'the env has no record',
      ['--env', 'acme', '--api-host', 'api.acme.vibase.ai', '--owner-email', OWNER, '--replace-instance', 'acme'],
      {},
      /no record.*without the flag/,
    ],
    [
      'Worker name equals the record',
      [...REPLACE, '--worker-name', OLD.worker],
      {},
      /--worker-name vault-smoked1.*Worker/,
    ],
    ['CRM D1 name equals the record', [...REPLACE, '--d1-name', OLD.d1], {}, /--d1-name vault-smoked1.*D1 database/],
    [
      'control D1 name equals the record',
      [...REPLACE, '--control-d1-name', 'vault-control-smoked1'],
      { configText: withControl },
      /--control-d1-name vault-control-smoked1.*control D1/,
    ],
    ['R2 name equals the record', [...REPLACE, '--r2-name', OLD.r2], {}, /--r2-name vault-smoked1-bodies.*R2 bucket/],
    [
      'Workflow name equals the record',
      REPLACE,
      { configText: sameWorkflow },
      /derived Workflow name vb-mail-sync-smoked1 equals the Workflow/,
    ],
    [
      'AUTH_SECRET already assigned in the instance file',
      REPLACE,
      { clerkEnvText: FILE_SECRET },
      /AUTH_SECRET.*already set in .env.smoked1.*never overwrite/,
    ],
  ]
  it.each(CASES)('%s: exit 1, zero wrangler calls, config unchanged', async (_n, argv, opts, cause) => {
    const w = world(opts)
    const before = w.state.configText
    for (const go of [run, dry]) {
      const o = await go(w, argv)
      expect(o.exitCode, said(w)).toBe(1)
      expect(o.results).toEqual([])
      expect(said(w)).toMatch(cause)
      expect(w.argv).toEqual([])
      expect(w.state.configWrites).toBe(0)
      expect(w.state.configText).toBe(before)
      expect(w.state.envFileText).toBe(opts.clerkEnvText ?? null)
    }
  })

  it.each([
    ['a differing --auth', [...BASE, '--auth', 'clerk', '--clerk-publishable-key', 'pk_test_x']],
    ['a differing --auth better-auth on the none record', [...BASE, '--auth', 'better-auth']],
    ['a differing name flag', [...BASE, '--worker-name', 'vb-smoked1']],
  ])('plain setup with %s is still refused, and now names --replace-instance', async (_n, argv) => {
    const w = world()
    const o = await dry(w, argv)
    expect(o.exitCode).toBe(1)
    expect(w.argv).toEqual([])
    expect(said(w)).toContain('--replace-instance')
    expect(w.state.configText).toBe(fixture)
  })
})

describe('2. the plan and the run on the smoked1 shape', () => {
  it('--dry-run reads only: prints the vb- plan and better-auth, makes no write call, no config write', async () => {
    const w = world()
    const o = await dry(w, REPLACE)
    expect(o.exitCode, said(w)).toBe(0)
    expect(w.writes()).toEqual([])
    expect(w.state.configWrites).toBe(0)
    expect(w.state.configText).toBe(fixture)
    expect(said(w)).toMatch(/auth better-auth,/)
    expect(step(o, 'config:resources').detail).toBe('D1 vb-crm-smoked1, D1 vb-control-smoked1, R2 vb-bodies-smoked1')
    expect(step(o, 'config:write').status).toBe('update')
    expect(said(w)).toContain('vb-smoked1')
  })

  it('the run creates the vb- resources, replaces the block and stops; plain setup then invites --owner-email', async () => {
    const w = world()
    const first = await run(w, REPLACE)
    expect(first.exitCode, said(w)).toBe(0)
    expect(first.stoppedAfterConfigWrite).toBe(true)
    expect(w.writes().map((c) => c.slice(-3).join(' '))).toEqual([
      'd1 create vb-crm-smoked1',
      'd1 create vb-control-smoked1',
      'bucket create vb-bodies-smoked1',
    ])
    const b = block(w.state.configText)
    expect(b.name).toBe('vb-smoked1')
    expect(b.vars.AUTH_PROVIDER).toBe('better-auth')
    expect(b.workflows).toEqual([
      { binding: 'MAIL_SYNC', name: 'vb-mail-sync-smoked1', class_name: 'MailSyncWorkflow' },
    ])
    expect(b.vars.PUBLIC_BASE_URL).toBe(`https://${HOST}`)
    w.logs.length = 0
    const second = await run(w, BASE)
    expect(second.exitCode, said(w)).toBe(0)
    expect(await rows(pair.control, 'select email, role from invitations')).toEqual([{ email: OWNER, role: 'owner' }])
  })
})

describe('3. nothing old is named', () => {
  const oldNames = [OLD.worker, OLD.d1, OLD.r2, OLD.id, OLD.workflow]
  const manualLine = (w: World) => {
    const at = w.logs.indexOf('manual:')
    return at < 0 ? '' : w.logs.slice(at + 1).join('\n')
  }
  it.each([
    ['dry-run', dry],
    ['run', run],
  ])('%s: no wrangler argument carries an old name or id; the manual line lists them all', async (_n, go) => {
    const w = world()
    const o = await go(w, REPLACE)
    expect(o.exitCode, said(w)).toBe(0)
    const calls = w.argv.map((c) => c.join(' ')).join('\n')
    for (const n of oldNames) expect(calls, n).not.toContain(n)
    if (_n === 'run') {
      expect(calls).toContain('d1 create vb-crm-smoked1')
      // the follow-up plain run, which reads the new record, names no old resource either
      await run(w, BASE)
      const all = w.argv.map((c) => c.join(' ')).join('\n')
      for (const n of oldNames) expect(all, n).not.toContain(n)
    }
    const manual = manualLine(w)
    expect(manual).toContain(OLD.worker)
    expect(manual).toContain(OLD.d1)
    expect(manual).toContain(OLD.r2)
    expect(manual).toContain(OLD.workflow)
    expect(manual).toMatch(/left in place/)
  })
  it('the manual line also lists a recorded control database', async () => {
    const w = world({ configText: withControl })
    await dry(w, REPLACE)
    expect(manualLine(w)).toContain('vault-control-smoked1')
  })
})

describe('4. the record', () => {
  it('the env block equals a new instance with the same names and ids; the rest is byte for byte; the resolvers accept it; plain setup plans no create', async () => {
    const reference = world({ configText: applyEdits(fixture, modify(fixture, ['env', 'smoked1'], undefined, fmt)) })
    await run(reference, [...BASE])
    const w = world()
    await run(w, REPLACE)
    // the reference is a plain new-instance block, which has no workflows this cycle (250.20): the replaced block differs by that entry alone
    const { workflows, ...rest } = block(w.state.configText)
    expect(workflows).toEqual([{ binding: 'MAIL_SYNC', name: 'vb-mail-sync-smoked1', class_name: 'MailSyncWorkflow' }])
    expect(rest).toEqual(block(reference.state.configText))
    // outside env.smoked1's value, the text is the fixture's
    const tree = parseTree(fixture)!
    const node = findNodeAtLocation(tree, ['env', 'smoked1'])!
    const prefix = fixture.slice(0, node.offset)
    const suffix = fixture.slice(node.offset + node.length)
    expect(w.state.configText.startsWith(prefix)).toBe(true)
    expect(w.state.configText.endsWith(suffix)).toBe(true)
    const cfg = block(w.state.configText)
    const target = requireControlTarget(cfg, 'smoked1')
    expect(target).toMatchObject({ workerName: 'vb-smoked1', databaseName: 'vb-crm-smoked1' })
    expect(target.control.databaseName).toBe('vb-control-smoked1')
    expect(resolveTarget(cfg, 'smoked1').databaseId).not.toBe(OLD.id)
    const again = await dry(w, BASE)
    expect(again.exitCode, said(w)).toBe(0)
    expect(step(again, 'config:resources').status).toBe('ok')
    expect(step(again, 'config:write').status).toBe('ok')
    expect(w.writes().length).toBe(3)
  })
})

describe('5. partial runs (P1)', () => {
  it('a failure after the first create and before the record write keeps the old block; a re-run with the flag completes with one of each resource', async () => {
    const w = world()
    failWhen(w, (a) => a.includes('r2') && a.includes('create'))
    const failed = await run(w, REPLACE)
    expect(failed.exitCode).toBe(1)
    expect(w.state.configText).toBe(fixture)
    expect(w.state.configWrites).toBe(0)
    expect(w.state.d1s.map((d) => d.name)).toContain('vb-crm-smoked1')
    const w2 = world({ d1s: w.state.d1s, r2s: w.state.r2s })
    const again = await run(w2, REPLACE)
    expect(again.exitCode, said(w2)).toBe(0)
    expect(w2.writes().map((c) => c.slice(-3).join(' '))).toEqual(['bucket create vb-bodies-smoked1'])
    expect(block(w2.state.configText).name).toBe('vb-smoked1')
    const names = (l: { name: string }[]) => l.map((d) => d.name).sort()
    expect(names(w2.state.d1s)).toEqual(['vault-smoked1', 'vb-control-smoked1', 'vb-crm-smoked1'])
    expect(w2.state.r2s.filter((n) => n === 'vb-bodies-smoked1')).toHaveLength(1)
    await run(w2, BASE)
    expect(await rows(pair.control, 'select email from invitations')).toHaveLength(1)
  })

  it('a failure after the record write: a re-run with the flag is refused (names equal the record), plain setup completes', async () => {
    const w = world()
    expect((await run(w, REPLACE)).exitCode).toBe(0)
    const written = w.state.configText
    failWhen(w, (a) => a.includes('migrations') && a.includes('apply'))
    expect((await run(w, BASE)).exitCode).toBe(1)
    expect(w.state.configText).toBe(written)
    const callsBefore = w.argv.length
    w.logs.length = 0
    const refused = await run(w, REPLACE)
    expect(refused.exitCode).toBe(1)
    expect(said(w)).toMatch(/equals the .* wrangler.jsonc records/)
    expect(w.argv.length).toBe(callsBefore)
    const fresh = world({ configText: written, d1s: w.state.d1s, r2s: w.state.r2s })
    const done = await run(fresh, BASE)
    expect(done.exitCode, said(fresh)).toBe(0)
    expect(block(fresh.state.configText)).toEqual(block(written))
    expect(await rows(pair.control, 'select email from invitations')).toHaveLength(1)
  })
})
