import { readFileSync } from 'node:fs'
import { defineCustomObject, parseSchemaFile } from '@vibase/api'
import { describe, expect, it } from 'vitest'
import { analyseDocuments, emitOperations, emitTypes, generateFiles } from '@vibase/sdk/emit'
import { loadDocuments } from './documents.js'
import { generateSdk } from './index.js'

// DX694 D4: the core is reached through the workspace subpath `@vibase/sdk/emit`.

describe('DX694 D4 the subpath with an injected translator', () => {
  it('generates a workspace map from two documents and a translator the caller supplies', async () => {
    const file = parseSchemaFile(readFileSync(new URL('./fixtures/workspace.schema.json', import.meta.url), 'utf8'))
    const documents = await loadDocuments({
      definitions: Object.entries(file.objects).map(([key, declaration]) => defineCustomObject(key, declaration)),
      ...(file.extend ? { extend: file.extend } : {}),
    })
    const calls: unknown[] = []
    const translate = async (document: unknown) => {
      calls.push(document)
      return `  // translated document ${calls.length}\n`
    }
    const profile = {
      header: '// test header\n',
      operationsName: 'workspaceOperations',
      mapName: 'WorkspaceOperations',
      tableFrom: '@vibase/sdk',
      helpersFrom: '@vibase/sdk',
    }
    const ops = analyseDocuments(documents)
    expect(emitOperations(ops, profile)).toContain('export const workspaceOperations')
    const types = await emitTypes(documents, ops, profile, translate)
    expect(calls).toEqual([documents.api, documents.meta])
    expect(types).toContain('export namespace ApiDocument {\n  // translated document 1\n}')
    expect(types).toContain('export namespace MetaDocument {\n  // translated document 2\n}')

    const viaCore = await generateFiles(documents, profile, translate)
    expect(calls.length).toBe(4)
    const viaRepo = await generateSdk(documents, profile)
    expect(viaCore.operations).toBe(viaRepo.operations)
    expect(viaCore.types).not.toBe(viaRepo.types)
    expect(viaCore.types).toContain('// translated document 3')
  }, 120_000)
})
