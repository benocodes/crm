import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BASE, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { applyExtensions, defineCustomObject, parseExtensionsFile } from '@vibase/api'
import { createTableStatements } from '@vibase/api'
import { openControlDb } from '@vibase/storage-d1'
import { uuidv7 } from '@vibase/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapD1 } from './bootstrap-d1.js'

// [[CORE543]] group 3 (D12, D28, P1, P7) in workerd with a REAL Text module: the real Worker entry (`worker.ts`) imports `vibase-extensions.json`, which a deploy attaches with a `Text` rule and this harness attaches as a Text module
// by the same name. The three states of the file (an object, none, invalid), and the rail seeing the definitions.
const ENTRY = fileURLToPath(new URL('./worker.ts', import.meta.url))
const MODULE = 'vibase-extensions.json'
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex')
const CRED = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')
const WITH_OBJECT = `${JSON.stringify(
  {
    version: 1,
    objects: { projects__c: { label: 'Projects', fields: { name: { kind: 'text', required: true } } } },
  },
  null,
  2,
)}\n`
const WITH_EXTEND = `${JSON.stringify(
  {
    version: 1,
    objects: {},
    extend: {
      contacts: {
        fields: { u2c_tier__c: { kind: 'enum', values: ['standard', 'gold'], required: true, default: 'standard' } },
      },
    },
  },
  null,
  2,
)}\n`
const INVALID_EXTEND = '{"version":1,"objects":{},"extend":{"contacts":{"fields":{"a__c":{"kind":"money"}}}}}\n'
const EMPTY = '{"version":1,"objects":{}}\n'
const INVALID = '{"version":1,"objects":{"projects__c":{"fields":{"x":{"kind":"money"}}}}}\n'
const SCOPES = [
  'projects__c:read',
  'projects__c:write',
  'projects__c:request_approval',
  'webhooks:read',
  'webhooks:write',
  'schema:read',
  'companies:read',
  'contacts:read',
  'contacts:write',
  'events:read',
]

let bundle: Bundle
const started: Workerd[] = []
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY, { external: [`*/${MODULE}`] })
}, 120_000)
afterAll(async () => {
  for (const w of started) await w.dispose()
  bundle?.dispose()
})

/** The Worker with `text` as its attached module, on a migrated database with the object's table (when it is valid and has objects) and an agent key holding the custom scopes. */
async function boot(text: string) {
  const w = await startWorkerd({
    bundle,
    textModules: { [MODULE]: text },
    bindings: { AUTH_PROVIDER: '', CREDENTIALS_KEY: CRED },
    outbound: () => new Response(null, { status: 503 }),
  })
  started.push(w)
  let definitions: ReturnType<typeof defineCustomObject>[] = []
  try {
    const file = parseExtensionsFile(text)
    definitions = Object.entries(file.objects).map(([k, d]) => defineCustomObject(k, d))
    for (const [k, d] of Object.entries(file.objects))
      await w.d1.batch(createTableStatements(k, d).map((s) => w.d1.prepare(s)))
    if (file.extend) expect((await applyExtensions(w.d1, {}, file.extend)).refused).toEqual([])
  } catch {
    // an invalid file has no definitions and no tables
  }
  const key = (
    await bootstrapD1(
      w.d1,
      {
        organizationName: 'Acme',
        agentName: 'bot',
        authOrgId: 'org_ext',
        scopes: definitions.length > 0 ? SCOPES : SCOPES.filter((s) => !s.startsWith('projects__c')),
      },
      { newId: () => uuidv7(), control: openControlDb(w.control), definitions },
    )
  ).key!
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await w.mf.dispatchFetch(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json().catch(() => null)) as any }
  }
  const health = async () =>
    ((await w.mf.dispatchFetch(`${BASE}/health`)) as unknown as Response).json() as Promise<any>
  return { w, call, health, key }
}

describe('the attached module has an object', () => {
  it('serves its REST list, reports {digest, objects} in /health', async () => {
    const { w, call, health } = await boot(WITH_OBJECT)
    const made = await call('POST', '/api/v1/projects__c', { name: 'Site rebuild' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const list = await call('GET', '/api/v1/projects__c')
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    const h = await health()
    expect(h.extensions).toEqual({ digest: sha256(WITH_OBJECT), objects: ['projects__c'] })
    expect(h.status).toBe('ok')
    expect(w.logs.join('\n')).not.toMatch(/extensions_invalid/)
  })
  it('the rail sees the definitions: the per-minute tick dispatches a webhook for a <key>__c.created event', async () => {
    const { w, call } = await boot(WITH_OBJECT)
    const sub = await call('POST', '/meta/v1/webhooks', {
      url: 'https://example.com/hook',
      event_types: ['projects__c.created'],
    })
    expect(sub.status, JSON.stringify(sub.body)).toBe(201)
    expect((await call('POST', '/api/v1/projects__c', { name: 'Hooked' })).status).toBe(201)
    await (await w.mf.getWorker()).scheduled({ cron: '* * * * *' })
    expect(await w.controlRows('select event_type from webhook_deliveries')).toEqual([
      { event_type: 'projects__c.created' },
    ])
  })
})

describe('the attached module extends contacts (CORE561 D12, D28, P2, P5)', () => {
  it('the entry hands extend to the composition: get and list carry the default, the filter answers, OpenAPI has the field on create and update', async () => {
    const { w, call, health } = await boot(WITH_EXTEND)
    // A contact that predates nothing: created through the API, so the required default is served.
    const made = await call('POST', '/api/v1/contacts', { name: 'Ada' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect((await call('GET', `/api/v1/contacts/${made.body.id}`)).body.u2c_tier__c).toBe('standard')
    const filtered = await call('GET', '/api/v1/contacts?u2c_tier__c=standard')
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200)
    expect(filtered.body.data).toHaveLength(1)
    expect((await call('GET', '/api/v1/contacts?u2c_tier__c=gold')).body.data).toHaveLength(0)
    expect((await call('PATCH', `/api/v1/contacts/${made.body.id}`, { u2c_tier__c: 'gold' })).body.u2c_tier__c).toBe(
      'gold',
    )
    const doc = (await call('GET', '/api/v1/openapi.json')).body
    const bodyProps = (m: string) =>
      Object.values(doc.paths as Record<string, any>).flatMap((p: any) =>
        p[m]?.requestBody ? [p[m].requestBody.content['application/json'].schema] : [],
      )
    expect(JSON.stringify(doc.paths['/api/v1/contacts'].post.requestBody)).toContain('u2c_tier__c')
    expect(JSON.stringify(doc.paths['/api/v1/contacts/{id}'].patch.requestBody)).toContain('u2c_tier__c')
    void bodyProps
    expect((await health()).extensions).toEqual({
      digest: sha256(WITH_EXTEND),
      objects: [],
      fields: ['contacts.u2c_tier__c'],
    })
    expect(w.logs.join('\n')).not.toMatch(/extensions_invalid/)
  })
  it('an invalid extend fails closed: 503 on REST and /mcp, /health 200 with the error', async () => {
    const { w, call, key, health } = await boot(INVALID_EXTEND)
    const r = await call('GET', '/api/v1/contacts')
    expect([r.status, r.body.error.code]).toEqual([503, 'extensions_invalid'])
    const mcp = (await w.mf.dispatchFetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })) as unknown as Response
    expect(mcp.status).toBe(503)
    expect((await health()).extensions).toEqual({ digest: sha256(INVALID_EXTEND), error: 'extensions_invalid' })
  })
  it('an objects-only module reports no fields key (CORE561 group 5)', async () => {
    const { health } = await boot(WITH_OBJECT)
    expect(Object.keys((await health()).extensions).sort()).toEqual(['digest', 'objects'])
  })
})

describe('the attached module declares no objects', () => {
  it('is the default: /health.extensions is null and there is no custom route', async () => {
    const { call, health } = await boot(EMPTY)
    expect((await health()).extensions).toBeNull()
    expect((await call('GET', '/api/v1/projects__c')).status).toBe(404)
    expect((await call('GET', '/api/v1/companies')).status).toBe(200)
  })
  it('the checked-in default module is the empty one', () => {
    expect(JSON.parse(readFileSync(new URL(`./${MODULE}`, import.meta.url), 'utf8'))).toEqual(JSON.parse(EMPTY))
  })
})

describe('the attached module is invalid (D28 fails closed)', () => {
  it('REST, an authenticated /mcp and schema.get answer 503 extensions_invalid; /health is 200 with the error and the digest', async () => {
    const { w, call, key, health } = await boot(INVALID)
    for (const [method, path] of [
      ['GET', '/api/v1/companies'],
      ['GET', '/api/v1/schema'],
      ['GET', '/api/v1/projects__c'],
    ] as const) {
      const r = await call(method, path)
      expect(r.status, path).toBe(503)
      expect(r.body.error.code, path).toBe('extensions_invalid')
    }
    const mcp = (await w.mf.dispatchFetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })) as unknown as Response
    expect(mcp.status).toBe(503)
    expect(((await mcp.json()) as any).error.code).toBe('extensions_invalid')
    const h = await health()
    expect(h.extensions).toEqual({ digest: sha256(INVALID), error: 'extensions_invalid' })
    expect(h.status).toBe('ok')
  })
})
