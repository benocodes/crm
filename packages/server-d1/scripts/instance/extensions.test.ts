// [[CORE543]] groups 1 and 2, the pure parts: the remote reader against the binding's (D30, P8), the file's validation and digest (D26), `/health.extensions` as the tooling reads it (P1), the recorded path in the settings (P3).
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { applyExtensions, readLiveSchema } from '../../../api/src/custom/apply.js'
import { parseExtensionsFile } from '../../../api/src/custom/extensions.js'
import {
  EMPTY_EXTENSIONS,
  liveExtensionsOf,
  loadExtensionsFile,
  readRemoteLiveSchema,
  runDigest,
  sha256Hex,
} from './extensions.js'
import { ext, extFile, sha256, sqliteD1 } from './extensions-kit.js'
import { parseSettings } from './settings.js'
import { cleanup, validSettings } from './test-kit.js'

afterEach(cleanup)

const objectsOf = (j: unknown) => parseExtensionsFile(JSON.stringify(j)).objects

describe('group 1: the remote reader equals readLiveSchema on the same database (P8, 542.20)', () => {
  it('a created table and an ADD COLUMN-altered one read the same through the row reader', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('create table companies (id text primary key) strict')
    const d1 = sqliteD1(db)
    expect((await applyExtensions(d1, objectsOf(ext.a()))).created).toEqual(['projects__c', 'milestones__c'])
    // Add a field to an existing table: the live CREATE text now carries an appended column (542.20).
    expect((await applyExtensions(d1, objectsOf(ext.b()))).added).toEqual([{ object: 'projects__c', field: 'note' }])
    const viaBinding = await readLiveSchema(d1)
    const viaRows = await readRemoteLiveSchema((sql) => db.prepare(sql).all() as unknown[])
    expect(viaRows).toEqual(viaBinding)
    expect(Object.keys(viaRows.tables).sort()).toEqual(['milestones__c', 'projects__c'])
    expect(viaRows.tables.projects__c!.columns.map((c) => c.name)).toContain('note')
  })
  it('the four extensible built-ins are in the snapshot beside the __c tables, as the binding reads them (CORE555 P6)', async () => {
    const db = new DatabaseSync(':memory:')
    for (const t of ['contacts', 'companies', 'deals', 'tasks'])
      db.exec(`create table ${t} (id text primary key, note__c text) strict`)
    const viaRows = await readRemoteLiveSchema((sql) => db.prepare(sql).all() as unknown[])
    expect(Object.keys(viaRows.builtins ?? {}).sort()).toEqual(['companies', 'contacts', 'deals', 'tasks'])
    expect(viaRows.builtins!.contacts!.columns.map((c) => c.name)).toEqual(['id', 'note__c'])
    expect(viaRows.tables).toEqual({})
    expect(viaRows).toEqual(await readLiveSchema(sqliteD1(db)))
  })
  it('a table name with a quote is read as data, never as SQL', async () => {
    const seen: string[] = []
    await readRemoteLiveSchema((sql) => {
      seen.push(sql)
      return /sqlite_master where type = 'table'/.test(sql)
        ? [{ name: "x'y__c", sql: 'create table "x\'y__c" ()' }]
        : []
    })
    expect(seen.some((s) => s.includes(`'x''y__c'`))).toBe(true)
  })
})

describe('group 2: the file, its digest and the live health (D26, P1)', () => {
  it('a valid file loads: bytes, digest of the bytes, the validated objects', () => {
    const p = extFile('a.json', ext.a())
    const run = loadExtensionsFile(p)
    expect(run.path).toBe(p)
    expect(Object.keys(run.objects)).toEqual(['projects__c', 'milestones__c'])
    expect(run.digest).toBe(sha256(run.bytes))
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256('abc'))
    expect(runDigest(run)).toBe(run.digest)
  })
  it('a file with no objects has a digest but reports none (the Worker reports null for it)', () => {
    const run = loadExtensionsFile(extFile('e.json', ext.empty()))
    expect(run.digest).toHaveLength(64)
    expect(runDigest(run)).toBeNull()
    expect(runDigest(null)).toBeNull()
    expect(EMPTY_EXTENSIONS).toBe('{"version":1,"objects":{}}\n')
  })
  const invalid: [string, string, string][] = [
    ['not JSON', '{nope', 'invalid_json'],
    ['an unknown key', '{"version":1,"objects":{},"x":1}', 'unknown_key'],
    [
      'extend naming a closed built-in',
      '{"version":1,"objects":{},"extend":{"messages":{"fields":{}}}}',
      'object_closed',
    ],
    [
      'a kind change refused by name',
      JSON.stringify({ version: 1, objects: { a__c: { fields: { x: { kind: 'money' } } } } }),
      '',
    ],
  ]
  for (const [name, text, rule] of invalid)
    it(`${name}: an InstanceRefusal naming the path${rule ? ` and the rule ${rule}` : ''}`, () => {
      const p = extFile('bad.json', text)
      try {
        loadExtensionsFile(p)
        throw new Error('did not refuse')
      } catch (e) {
        expect((e as Error).name).not.toBe('')
        expect(String((e as Error).message)).toContain(p)
        if (rule) expect(String((e as Error).message)).toContain(rule)
      }
    })
  it('a missing file is a refusal naming the path', () => {
    expect(() => loadExtensionsFile('/nonexistent/dir/ext.json')).toThrow(/\/nonexistent\/dir\/ext\.json/)
  })
  it('an extend-only file loads with its extend and a digest it reports (CORE561 P3)', () => {
    const run = loadExtensionsFile(extFile('x.json', ext.x()))
    expect(Object.keys(run.objects)).toEqual([])
    expect(Object.keys(run.extend.contacts ?? {})).toEqual(['tier__c', 'code__c'])
    expect(runDigest(run)).toBe(run.digest)
    expect(loadExtensionsFile(extFile('ax.json', ext.ax())).extend.contacts).toBeDefined()
  })
  it('an extend with no fields is not a file: the digest is none, like the empty file (CORE561 P3)', () => {
    expect(runDigest(loadExtensionsFile(extFile('nf.json', ext.noFields())))).toBeNull()
    expect(loadExtensionsFile(extFile('e.json', ext.empty())).extend).toEqual({})
  })
  it('an extend refusal names the path and the rule through loadExtensionsFile (CORE561 P1)', () => {
    const p = extFile('k.json', {
      version: 1,
      objects: {},
      extend: { contacts: { fields: { a__c: { kind: 'money' } } } },
    })
    expect(() => loadExtensionsFile(p)).toThrow(/unknown_kind at extend\.contacts\.fields\.a__c/)
  })
  it('/health.fields is read; an objects-less body with fields is a file, not none (CORE561 P2)', () => {
    expect(liveExtensionsOf({ extensions: { digest: 'd', objects: [], fields: ['contacts.x__c'] } })).toEqual({
      digest: 'd',
      objects: [],
      fields: ['contacts.x__c'],
    })
    expect(liveExtensionsOf({ extensions: { digest: 'd', fields: ['contacts.x__c'] } })).toEqual({
      digest: 'd',
      objects: [],
      fields: ['contacts.x__c'],
    })
    expect(liveExtensionsOf({ extensions: { digest: 'd', objects: ['a__c'] } })).toEqual({
      digest: 'd',
      objects: ['a__c'],
    })
  })
  it('/health.extensions is read as the four shapes; no key counts as none; an error counts as a file (P1)', () => {
    expect(liveExtensionsOf({})).toBeNull()
    expect(liveExtensionsOf({ extensions: null })).toBeNull()
    expect(liveExtensionsOf({ extensions: { digest: 'd', objects: ['a__c'] } })).toEqual({
      digest: 'd',
      objects: ['a__c'],
    })
    expect(liveExtensionsOf({ extensions: { digest: 'd', error: 'extensions_invalid' } })).toEqual({
      digest: 'd',
      error: 'extensions_invalid',
    })
    expect(liveExtensionsOf({ extensions: 'junk' })).toBeNull()
  })
})

describe('the recorded path in the settings (P3)', () => {
  const text = (over: Record<string, unknown>) => JSON.stringify(validSettings(over))
  it('an absolute path is a key of the settings file; a relative one is refused naming the key', () => {
    expect(parseSettings(text({ extensions: '/abs/ext.json' }), 'demo', '/s/demo.json').extensions).toBe(
      '/abs/ext.json',
    )
    expect(() => parseSettings(text({ extensions: 'rel/ext.json' }), 'demo', '/s/demo.json')).toThrow(/extensions/)
    expect(() => parseSettings(text({ extensions: 5 }), 'demo', '/s/demo.json')).toThrow(/extensions/)
    expect(parseSettings(text({}), 'demo', '/s/demo.json').extensions).toBeUndefined()
  })
})
