import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliError } from './errors.js'
import { deriveCommand, deriveCommands, mergeDocuments } from './derive.js'
import { parseInvocation, type InvokeIo } from './invoke.js'
import { apiDoc, metaDoc } from './test/fixtures.js'
import type { Command } from './types.js'

// [[API6]] D7: commands are derived from the merged documents; flags and positionals from each operation.

const merged = () => mergeDocuments([{ source: 'api', doc: apiDoc() }, { source: 'meta', doc: metaDoc() }])
const commands = () => deriveCommands(merged())
const cmd = (id: string): Command => {
  const c = commands().find((x) => x.operationId === id)
  if (!c) throw new Error(`no command for ${id}`)
  return c
}
const io = (files: Record<string, string> = {}, stdin = ''): InvokeIo => ({
  readFile: async (p) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`)
    return files[p]!
  },
  readStdin: async () => stdin,
})
const parse = (id: string, args: string[], i: InvokeIo = io()) => parseInvocation(cmd(id), args, i)
const usageError = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (x) => x,
  )
  expect(e).toBeInstanceOf(CliError)
  expect((e as CliError).exit).toBe(2)
  return e as CliError
}

describe('document merge', () => {
  it('merges both documents by operationId, records the source, and skips routes without an operationId', () => {
    const ids = merged().map((o) => o.id)
    expect(ids).toEqual(expect.arrayContaining(['widgets.list', 'widgets.create', 'parts.get', 'me.get', 'api_keys.revoke']))
    expect(ids.every(Boolean)).toBe(true)
    expect(merged().find((o) => o.id === 'me.get')?.source).toBe('meta')
    expect(commands().map((c) => c.path)).not.toContain('/api/v1/ping')
    expect(merged().map((o) => o.path)).not.toContain('/api/v1/ping')
  })

  it('a duplicate operationId across the documents is a usage error naming both', () => {
    const meta = metaDoc()
    meta.paths['/meta/v1/dup'] = { get: { operationId: 'widgets.list', summary: 'dup', responses: { '200': { description: 'ok' } } } }
    let err: unknown
    try {
      mergeDocuments([{ source: 'api', doc: apiDoc() }, { source: 'meta', doc: meta }])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).exit).toBe(2)
    const msg = (err as CliError).message
    expect(msg).toContain('widgets.list')
    expect(msg).toContain('/api/v1/widgets')
    expect(msg).toContain('/meta/v1/dup')
  })
})

describe('command names', () => {
  it('<resource> <action> from the dotted operationId; underscores become hyphens', () => {
    expect(cmd('widgets.create')).toMatchObject({ resource: 'widgets', action: 'create', method: 'POST' })
    expect(cmd('api_keys.revoke')).toMatchObject({ resource: 'api-keys', action: 'revoke' })
    expect(cmd('me.get')).toMatchObject({ resource: 'me', action: 'get' })
  })

  it('detects binary operations from the document content types and lists from the cursor shape', () => {
    expect(cmd('files.content').binary).toBe(true)
    expect(cmd('widgets.list').binary).toBe(false)
    expect(cmd('parts.delete').binary).toBe(false)
    expect(cmd('widgets.list').paginated).toBe(true)
    expect(cmd('widgets.create').paginated).toBe(false)
  })
})

describe('positional path parameters', () => {
  it('are positional in path order and percent-encoded', async () => {
    expect(cmd('parts.get').pathParams).toEqual(['widget_id', 'part_id'])
    const inv = await parse('parts.get', ['W1', 'a b/c'])
    expect(inv.path).toBe('/api/v1/widgets/W1/parts/a%20b%2Fc')
  })

  it('too few or too many positionals is a usage error', async () => {
    await usageError(parse('parts.get', ['only-one']))
    await usageError(parse('parts.get', ['a', 'b', 'c']))
    await usageError(parse('me.get', ['extra']))
  })
})

describe('flags', () => {
  it('are kebab-case, typed from the schema (string, integer, number, boolean, JSON object and array)', async () => {
    const flags = Object.fromEntries(cmd('widgets.create').flags.map((f) => [f.name, f.type]))
    expect(flags).toMatchObject({ name: 'string', size: 'integer', ratio: 'number', enabled: 'boolean', meta: 'json', tags: 'json', 'due-at': 'string' })
    const inv = await parse('widgets.create', ['--name', 'plain', '--size', '3', '--ratio', '1.5', '--enabled', '--meta', '{"a":1}', '--tags', '["x","y"]', '--due-at', '2026-01-01'])
    expect(inv.body).toEqual({ name: 'plain', size: 3, ratio: 1.5, enabled: true, meta: { a: 1 }, tags: ['x', 'y'], due_at: '2026-01-01' })
  })

  it('--no-<flag> sets a boolean false', async () => {
    expect((await parse('widgets.create', ['--no-enabled'])).body).toEqual({ enabled: false })
  })

  it('a value that does not fit its type is a usage error', async () => {
    await usageError(parse('widgets.create', ['--size', 'abc']))
    await usageError(parse('widgets.create', ['--size', '1.5']))
    await usageError(parse('widgets.create', ['--ratio', 'x']))
    await usageError(parse('widgets.create', ['--meta', '{nope']))
    await usageError(parse('widgets.list', ['--color', 'green']))
    await usageError(parse('widgets.create', ['--nonsense', '1']))
  })

  it('query parameters become query pairs', async () => {
    const inv = await parse('widgets.list', ['--limit', '5', '--after', 'X', '--color', 'red', '--active'])
    expect(inv.path).toBe('/api/v1/widgets')
    expect(inv.query).toEqual(expect.arrayContaining([['limit', '5'], ['after', 'X'], ['color', 'red'], ['active', 'true']]))
    expect(inv.query).toHaveLength(4)
    expect(inv.body).toBeUndefined()
  })

  it('a body property named like a query parameter is the query flag, and the property is reachable through --data', async () => {
    const c = cmd('parts.update')
    expect(c.flags.filter((f) => f.name === 'color')).toEqual([expect.objectContaining({ where: 'query' })])
    expect(c.dataOnly).toContain('color')
    const viaFlag = await parse('parts.update', ['w', 'p', '--color', 'red'])
    expect(viaFlag.query).toEqual([['color', 'red']])
    expect(viaFlag.body).toEqual({})
    expect((await parse('parts.update', ['w', 'p', '--data', '{"color":"blue"}'])).body).toEqual({ color: 'blue' })
  })

  it('a null is never a flag value: the string "null" stays a string', async () => {
    expect((await parse('widgets.create', ['--due-at', 'null'])).body).toEqual({ due_at: 'null' })
    expect((await parse('widgets.create', ['--name', 'null'])).body).toEqual({ name: 'null' })
  })

  it('sends an empty object when a required body has no fields, and no body for a bodyless operation', async () => {
    expect((await parse('widgets.create', [])).body).toEqual({})
    expect((await parse('parts.get', ['a', 'b'])).body).toBeUndefined()
  })
})

describe('--data', () => {
  it('takes JSON inline, from @file, or from stdin', async () => {
    expect((await parse('widgets.create', ['--data', '{"name":"inline"}'])).body).toEqual({ name: 'inline' })
    expect((await parse('widgets.create', ['--data', '@body.json'], io({ 'body.json': '{"name":"file"}' }))).body).toEqual({ name: 'file' })
    expect((await parse('widgets.create', ['--data', '-'], io({}, '{"name":"stdin"}'))).body).toEqual({ name: 'stdin' })
  })

  it('reads @file from the disk when no reader is injected by the caller', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibase-data-'))
    try {
      writeFileSync(join(dir, 'b.json'), '{"size":9}')
      const { readFile } = await import('node:fs/promises')
      expect((await parse('widgets.create', ['--data', `@${join(dir, 'b.json')}`], { readFile: (p) => readFile(p, 'utf8'), readStdin: async () => '' })).body).toEqual({ size: 9 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags override its keys, and null reaches the API only through --data', async () => {
    const inv = await parse('widgets.create', ['--data', '{"name":"a","size":1,"due_at":null}', '--size', '2'])
    expect(inv.body).toEqual({ name: 'a', size: 2, due_at: null })
  })

  it('invalid JSON, an unreadable file, or flags beside a non-object body are usage errors', async () => {
    await usageError(parse('widgets.create', ['--data', '{bad']))
    await usageError(parse('widgets.create', ['--data', '@missing.json']))
    await usageError(parse('widgets.create', ['--data', '[1]', '--size', '1']))
  })
})

describe('reserved global names', () => {
  it('a body property with a reserved name has no flag and is set through --data', async () => {
    const c = cmd('widgets.create')
    expect(c.flags.map((f) => f.name)).not.toContain('data')
    expect(c.dataOnly).toContain('data')
    expect((await parse('widgets.create', ['--data', '{"data":"payload"}'])).body).toEqual({ data: 'payload' })
  })

  it('a query parameter with a reserved name fails derivation for that operation only, with a clear error', async () => {
    const reports = cmd('reports.list')
    expect(reports.error).toMatch(/output/)
    expect(reports.error).toMatch(/reserved/)
    const e = await usageError(parse('reports.list', []))
    expect(e.message).toMatch(/output/)
    // The other operations are unaffected.
    expect(cmd('widgets.list').error).toBeUndefined()
    expect(deriveCommand(merged().find((o) => o.id === 'widgets.list')!).error).toBeUndefined()
  })
})
