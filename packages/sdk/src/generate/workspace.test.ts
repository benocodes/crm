import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineCustomObject, parseSchemaFile } from '@vibase/api'
import { beforeAll, describe, expect, it } from 'vitest'
import { documentsApp, loadDocuments } from './documents.js'
import { generateWorkspace } from './workspace.js'

// DX604 D1, D3, D7: the workspace map from a schema file and from a deployment's documents.
const SCHEMA_NAME = 'workspace.schema.json'
const schemaText = readFileSync(new URL(`./fixtures/${SCHEMA_NAME}`, import.meta.url), 'utf8')
const fixture = (name: string) => readFileSync(new URL(`./fixtures/workspace/${name}`, import.meta.url), 'utf8')

function firstDifference(committed: string, generated: string): string {
  const a = committed.split('\n')
  const b = generated.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: committed ${JSON.stringify(a[i])}, generated ${JSON.stringify(b[i])}`
  }
  return 'no difference'
}
const withoutSourceLine = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.startsWith('// Source: '))
    .join('\n')
const headerOf = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.startsWith('//'))
    .join('\n')

const origin = 'https://acme.example'
const workspace = () => {
  const file = parseSchemaFile(schemaText)
  return {
    definitions: Object.entries(file.objects).map(([key, declaration]) => defineCustomObject(key, declaration)),
    ...(file.extend ? { extend: file.extend } : {}),
  }
}
/** A fetch that serves the in-process app; records every call. */
const servingFetch = () => {
  const app = documentsApp(workspace())
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return app.request(String(input), init)
  }) as typeof fetch
  return Object.assign(fn, { calls })
}

let fromSchema: { operations: string; types: string }
let digest: string
beforeAll(async () => {
  fromSchema = await generateWorkspace({ source: { schema: schemaText, name: SCHEMA_NAME } })
  digest = createHash('sha256').update(schemaText).digest('hex')
}, 120_000)

describe('DX604 the schema-file source', () => {
  it('names the workspace exports and imports its helpers from @vibase/sdk', () => {
    expect(fromSchema.operations).toContain('export const workspaceOperations: OperationTable<WorkspaceOperations>')
    expect(fromSchema.operations).toContain(`from '@vibase/sdk'`)
    expect(fromSchema.operations).toContain(`from './types.js'`)
    expect(fromSchema.types).toContain('export type WorkspaceOperations = {')
    expect(fromSchema.types).toContain(`import type { ArgsOf, ItemOf, ResultOf, WithFilters } from '@vibase/sdk'`)
    expect(fromSchema.operations).not.toContain('builtInOperations')
    expect(fromSchema.types).not.toContain('BuiltInOperations')
  })

  it('holds the built-ins and the custom namespace verbatim', () => {
    expect(fromSchema.operations).toContain(`'projects__c.list': {\n    "namespace": "projects__c"`)
    expect(fromSchema.operations).toContain(`'contacts.list'`)
    expect(fromSchema.operations).not.toContain('projectsC')
  })

  it('writes a header with the command, the file name and digest, and info.version, and no timestamp (D7)', async () => {
    const documents = await loadDocuments(workspace())
    const version = (documents.api as { info: { version: string } }).info.version
    for (const text of [fromSchema.operations, fromSchema.types]) {
      const header = headerOf(text)
      expect(header).toContain('pnpm -C packages/sdk generate')
      expect(header).toContain(`// Source: --schema ${SCHEMA_NAME} (sha256 ${digest})`)
      expect(header).toContain(`info.version ${version}`)
      expect(header).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  }, 60_000)

  it('is byte-identical when generated twice from the same file', async () => {
    const again = await generateWorkspace({ source: { schema: schemaText, name: SCHEMA_NAME } })
    expect(again).toEqual(fromSchema)
  }, 120_000)

  it('has a source line that changes with the file bytes', async () => {
    const other = await generateWorkspace({ source: { schema: `${schemaText}\n`, name: SCHEMA_NAME } })
    expect(headerOf(other.operations)).not.toBe(headerOf(fromSchema.operations))
  }, 120_000)

  it('equals the committed fixture map that the typecheck proof compiles', () => {
    for (const [file, text] of [
      ['operations.ts', fromSchema.operations],
      ['types.ts', fromSchema.types],
    ] as const) {
      const committed = fixture(file)
      if (committed !== text)
        throw new Error(
          `packages/sdk/src/generate/fixtures/workspace/${file} is out of date (${firstDifference(committed, text)}). ` +
            'Regenerate it: pnpm -C packages/sdk generate --schema packages/sdk/src/generate/fixtures/workspace.schema.json --out packages/sdk/src/generate/fixtures/workspace' +
            ' (from the repo root: relative paths resolve against where pnpm was invoked)',
        )
    }
  })

  it('refuses an invalid schema file with the DeclarationError rule and path', async () => {
    const bad = JSON.stringify({ version: 1, define: { projects: { label: 'P', fields: {} } } })
    const error = await generateWorkspace({ source: { schema: bad, name: 'bad.json' } }).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error.message)).toContain('bad.json')
    expect(String(error.message)).toContain('key_suffix')
    expect(String(error.message)).toContain('projects')
  })
})

describe('DX604 the --url source', () => {
  it('yields the same two files as the schema source, but for the source line, with no credential and redirect: error', async () => {
    const fetch = servingFetch()
    const fromUrl = await generateWorkspace({ source: { url: origin, fetch } })
    expect(withoutSourceLine(fromUrl.operations)).toBe(withoutSourceLine(fromSchema.operations))
    expect(withoutSourceLine(fromUrl.types)).toBe(withoutSourceLine(fromSchema.types))
    expect(headerOf(fromUrl.operations)).toContain(`// Source: --url ${origin}`)
    expect(fetch.calls.map((c) => c.url).sort()).toEqual([
      `${origin}/api/v1/openapi.json`,
      `${origin}/meta/v1/openapi.json`,
    ])
    for (const call of fetch.calls) {
      expect(call.init?.redirect).toBe('error')
      const headers = new Headers(call.init?.headers)
      expect(headers.has('authorization')).toBe(false)
    }
  }, 120_000)

  it('accepts a local http origin and a bare trailing slash', async () => {
    for (const local of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787', `${origin}/`]) {
      const fetch = servingFetch()
      await generateWorkspace({ source: { url: local, fetch } })
      expect(fetch.calls.length).toBe(2)
    }
  }, 240_000)

  const never = (async () => {
    throw new Error('fetch must not be called')
  }) as typeof fetch
  it.each([
    ['an http non-local origin', 'http://acme.example', /https/],
    ['an origin with a path', 'https://acme.example/v1', /origin/],
    ['an origin with a query', 'https://acme.example?x=1', /origin/],
    ['an origin with a fragment', 'https://acme.example#x', /origin/],
    ['an origin with credentials', 'https://user:pw@acme.example', /credential/],
    ['not a URL', 'acme', /URL/],
  ])('refuses %s before any request', async (_label, url, pattern) => {
    const error = await generateWorkspace({ source: { url, fetch: never } }).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error.message)).toMatch(pattern)
    expect(String(error.message)).not.toContain('fetch must not be called')
  })

  it.each([
    ['a non-2xx document', () => new Response('nope', { status: 503 }), /503/],
    ['a JSON body without paths', () => Response.json({ openapi: '3.1.0' }), /paths/],
    ['a JSON array', () => Response.json([]), /paths/],
    ['a non-JSON body', () => new Response('<html>', { status: 200 }), /JSON/],
  ])('refuses %s, naming the URL', async (_label, respond, pattern) => {
    const failing = (async () => respond()) as typeof fetch
    const error = await generateWorkspace({ source: { url: origin, fetch: failing } }).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error.message)).toContain(`${origin}/api/v1/openapi.json`)
    expect(String(error.message)).toMatch(pattern)
  })
})
