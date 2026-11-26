import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry, defineCustomObject, parseSchemaFile } from '@vibase/api'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS } from '@vibase/storage-d1'
import { uuidv7 } from '@vibase/storage'
import type { D1WorkerEnv } from './compose.js'
import { DECLARED_SCOPES } from './declared-scopes.js'
import { declaredScopesWith, earlyAnswer } from './early.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { bootstrapD1, composeD1Worker, NOW, openWorkerD1, type WorkerD1 } from './test/kit.js'

// #522: the Worker answers the unauthenticated `/mcp` request and the discovery documents from its variables, before it loads the composition or reads a database. The answers must be the composition's own.

let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
}, 60_000)
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(
    w.d1,
    MIGRATIONS.map((m) => m.name),
  )
  // A healthy instance: the composition's own answers are then the ones to compare with (an unpaired control database is a 503 it gives and the early answers deliberately do not).
  await bootstrapD1(w.d1, { organizationName: 'Acme', authOrgId: 'org_early' }, { now: NOW, newId: () => uuidv7(NOW) })
})

const ORIGIN = 'https://app.example.test'
const env = (over: Partial<D1WorkerEnv> = {}): D1WorkerEnv =>
  ({
    DB: w.d1,
    CONTROL_DB: w.control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
    CORS_ALLOWED_ORIGINS: ORIGIN,
    ...over,
  }) as D1WorkerEnv
const req = (path: string, init: RequestInit = {}) => new Request(AUTH_BASE + path, init)
const MCP_INIT = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
}
const same = async (a: Response, b: Response) => {
  expect(a.status).toBe(b.status)
  expect(await a.text()).toBe(await b.text())
  for (const h of [
    'www-authenticate',
    'content-type',
    'access-control-allow-origin',
    'access-control-expose-headers',
    'vary',
  ])
    expect(a.headers.get(h), h).toBe(b.headers.get(h))
}

describe('the declared scopes the early answers use', () => {
  it('equal the registry (regenerate src/declared-scopes.ts when this fails)', () => {
    expect([...DECLARED_SCOPES]).toEqual(createVibaseRegistry().declaredScopes())
  })
})

describe('an early answer is the composition answer', () => {
  it.each([
    ['the unauthenticated /mcp 401', '/mcp', MCP_INIT],
    ['the same with an allowed Origin', '/mcp', { ...MCP_INIT, headers: { ...MCP_INIT.headers, origin: ORIGIN } }],
    [
      'the same with a foreign Origin (403)',
      '/mcp',
      { ...MCP_INIT, headers: { ...MCP_INIT.headers, origin: 'https://evil.test' } },
    ],
    ['the protected-resource document', '/.well-known/oauth-protected-resource', {}],
    ['the MCP protected-resource document', '/.well-known/oauth-protected-resource/mcp', {}],
    ['the preflight of a document', '/.well-known/oauth-protected-resource/mcp', { method: 'OPTIONS' }],
    ['HEAD of a document', '/.well-known/oauth-protected-resource', { method: 'HEAD' }],
    ['the path-inserted authorization-server metadata', '/.well-known/oauth-authorization-server/auth', {}],
  ])('%s', async (_name, path, init) => {
    const early = earlyAnswer(req(path, init), env())
    expect(early, 'answered early').toBeDefined()
    await same(early!, await composeD1Worker(env()).fetch(req(path, init)))
  })
})

describe('with no CORS list', () => {
  it.each([
    ['the 401 with an Origin refused', { ...MCP_INIT, headers: { ...MCP_INIT.headers, origin: ORIGIN } }],
    ['the 401 with none', MCP_INIT],
  ])('%s', async (_n, init) => {
    const e = env({ CORS_ALLOWED_ORIGINS: '' })
    const early = earlyAnswer(req('/mcp', init), e)
    expect(early).toBeDefined()
    await same(early!, await composeD1Worker(e).fetch(req('/mcp', init)))
  })
})

describe('what is not answered early', () => {
  it.each([
    [
      'a request with a credential',
      '/mcp',
      { ...MCP_INIT, headers: { ...MCP_INIT.headers, authorization: 'Bearer x' } },
    ],
    ['GET /mcp', '/mcp', {}],
    ['a client registration', '/auth/oauth2/register', { method: 'POST' }],
    ['the vibase discovery document', '/.well-known/vibase', {}],
    ['an operation', '/api/v1/contacts', {}],
  ])('%s', (_n, path, init) => {
    expect(earlyAnswer(req(path, init), env())).toBeUndefined()
  })

  it.each([
    ['another provider', { AUTH_PROVIDER: 'clerk' }],
    ['no provider', { AUTH_PROVIDER: '' }],
    ['a missing base URL', { PUBLIC_BASE_URL: undefined }],
    ['a base URL with a path', { PUBLIC_BASE_URL: `${AUTH_BASE}/x` }],
    ['a plain-http base URL', { PUBLIC_BASE_URL: 'http://vibase.test' }],
    ['a malformed CORS list', { CORS_ALLOWED_ORIGINS: 'not-an-origin' }],
  ] as const)('%s: the full path decides', (_n, over) => {
    expect(earlyAnswer(req('/mcp', MCP_INIT), env(over as Partial<D1WorkerEnv>))).toBeUndefined()
  })
})

// [[CORE543]] P5 (group 5): the early answers list the custom scopes of the attached module, derived by `JSON.parse` and a name check, with no validator.
const TWO = JSON.stringify({
  version: 1,
  define: {
    projects__c: { label: 'Projects', fields: { name: { kind: 'text', required: true } } },
    milestones__c: { fields: { project: { kind: 'reference', target: 'projects__c' } } },
  },
})
const twoDefinitions = () =>
  Object.entries(parseSchemaFile(TWO).objects).map(([key, decl]) => defineCustomObject(key, decl))
const scopesOf = (header: string | null) => (/scope="([^"]*)"/.exec(header ?? '')?.[1] ?? '').split(' ').sort()

describe('the early answers with an attached module (P5)', () => {
  it('the derived list equals the registry built with the same definitions (the drift test, extended)', () => {
    const want = createVibaseRegistry({ definitions: twoDefinitions() }).declaredScopes()
    expect(want).toContain('projects__c:read')
    expect(want).toContain('milestones__c:request_approval')
    expect([...declaredScopesWith(TWO)!]).toEqual(want)
  })
  it('an extend-only module adds no scope (CORE561 P5): the early answer is the static list, equal to no file', () => {
    const text = '{"version":1,"define":{},"extend":{"contacts":{"fields":{"u2c_tier__c":{"kind":"text"}}}}}'
    expect(declaredScopesWith(text)).toEqual(DECLARED_SCOPES)
    expect(declaredScopesWith(text)).toEqual(declaredScopesWith(undefined))
    const req2 = new Request('https://api.test/mcp', { method: 'POST', headers: { origin: ORIGIN } })
    const withNone = earlyAnswer(req2, env())!
    const withExtend = earlyAnswer(req2, env(), text)!
    expect(withExtend.status).toBe(withNone.status)
    expect(withExtend.headers.get('www-authenticate')).toBe(withNone.headers.get('www-authenticate'))
  })
  it('no objects, or the default module, is the static list; an unreadable module is undefined', () => {
    expect(declaredScopesWith('{"version":1,"define":{}}\n')).toEqual(DECLARED_SCOPES)
    expect(declaredScopesWith(undefined)).toEqual(DECLARED_SCOPES)
    for (const bad of [
      '{nope',
      '[]',
      '{"version":1}',
      '{"define":{"Projects":{}}}',
      '{"define":{"a__c":1,"b":{}}}',
      '{"define":[]}',
    ])
      expect(declaredScopesWith(bad), bad).toBeUndefined()
  })
  it('the unauthenticated /mcp challenge, the authorization-server metadata and both protected-resource documents are the composition’s own, custom scopes included', async () => {
    const wk = () => composeD1Worker(env(), { definitions: twoDefinitions() })
    for (const [path, init] of [
      ['/mcp', MCP_INIT],
      ['/.well-known/oauth-protected-resource', {}],
      ['/.well-known/oauth-protected-resource/mcp', {}],
      ['/.well-known/oauth-authorization-server/auth', {}],
    ] as const) {
      const early = earlyAnswer(req(path, init), env(), TWO)
      expect(early, path).toBeDefined()
      await same(early!, await wk().fetch(req(path, init)))
    }
    const challenge = earlyAnswer(req('/mcp', MCP_INIT), env(), TWO)!.headers.get('www-authenticate')
    expect(scopesOf(challenge)).toContain('projects__c:read')
    const doc = (await earlyAnswer(req('/.well-known/oauth-protected-resource', {}), env(), TWO)!.json()) as {
      scopes_supported: string[]
    }
    expect(doc.scopes_supported).toContain('milestones__c:write')
  })
  it('a module the light check cannot read sends the request the full way', () => {
    expect(earlyAnswer(req('/mcp', MCP_INIT), env(), '{nope')).toBeUndefined()
    expect(earlyAnswer(req('/.well-known/oauth-protected-resource', {}), env(), '{"define":{"x":1}}')).toBeUndefined()
  })
  it('early.ts imports no validator and no composition', () => {
    const src = readFileSync(new URL('./early.ts', import.meta.url), 'utf8')
    const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1])
    expect(imports.sort()).toEqual(
      ['./declared-scopes.js', '@vibase/api/discovery', '@vibase/api/origins', '@vibase/auth/static-metadata'].sort(),
    )
    expect(src).not.toMatch(/zod|parseSchemaFile|parseObjectDeclaration/)
  })
})
