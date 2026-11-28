import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineCustomObject, parseSchemaFile } from '@vibase/api'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadDocuments } from './documents.js'
import { generateWorkspace } from './workspace.js'

// DX604 D1, D3, D7: the workspace map from a schema file (DX694 D7: a deployed instance is `vibase gen types`'s source).
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
const headerOf = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.startsWith('//'))
    .join('\n')

const workspace = () => {
  const file = parseSchemaFile(schemaText)
  return {
    definitions: Object.entries(file.objects).map(([key, declaration]) => defineCustomObject(key, declaration)),
    ...(file.extend ? { extend: file.extend } : {}),
  }
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

  it('holds the built-ins, a one-word custom namespace verbatim and a multi-word one camelCased with its __c suffix (CORE692 D1)', () => {
    expect(fromSchema.operations).toContain(`'projects__c.list': {\n    "namespace": "projects__c"`)
    expect(fromSchema.operations).toContain(`'session_recordings__c.list': {\n    "namespace": "sessionRecordings__c"`)
    expect(fromSchema.operations).toContain(`'contacts.list'`)
    expect(fromSchema.operations).not.toContain('projectsC')
    expect(fromSchema.operations).not.toContain('sessionRecordingsC')
    expect(fromSchema.operations).not.toContain('"session_recordings__c"')
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

describe('DX694 D7 the url source is gone', () => {
  it('has a source type with no url member (a type-level negative; the arrow is never called)', () => {
    // @ts-expect-error `url` is not a WorkspaceSource member any more
    const _never = () => generateWorkspace({ source: { url: 'https://acme.example' } })
    expect(typeof _never).toBe('function')
  })
})
