import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { builtInOperations } from '../generated/operations.js'
import { GENERATE_COMMAND, generateSdk, loadDocuments } from './index.js'

// DX603 D2: the committed files equal the generator's output over the in-process documents.
const read = (name: string) => readFileSync(new URL(`../generated/${name}`, import.meta.url), 'utf8')

function firstDifference(committed: string, generated: string): string {
  const a = committed.split('\n')
  const b = generated.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: committed ${JSON.stringify(a[i])}, generated ${JSON.stringify(b[i])}`
  }
  return 'no difference'
}

function operationIds(document: any): string[] {
  const ids: string[] = []
  for (const item of Object.values<any>(document.paths))
    for (const op of Object.values<any>(item)) if (typeof op?.operationId === 'string') ids.push(op.operationId)
  return ids
}

describe('DX603 D2 generated files', () => {
  it('are what the generator writes from the production documents', async () => {
    const generated = await generateSdk(await loadDocuments())
    for (const [file, text] of [
      ['operations.ts', generated.operations],
      ['types.ts', generated.types],
    ] as const) {
      const committed = read(file)
      if (committed !== text)
        throw new Error(
          `packages/sdk/src/generated/${file} is out of date (${firstDifference(committed, text)}). ` +
            `An operation or its schema changed: regenerate the SDK with \`${GENERATE_COMMAND}\` and commit the result.`,
        )
    }
  }, 60_000)

  it('hold every operation id of both documents, in the table and in the map', async () => {
    const documents = await loadDocuments()
    const ids = [...operationIds(documents.api), ...operationIds(documents.meta)]
    expect(ids.length).toBeGreaterThan(100)
    const types = read('types.ts')
    expect(Object.keys(builtInOperations).sort()).toEqual([...ids].sort())
    for (const id of ids) expect(types, id).toContain(`'${id}': {\n    namespace:`)
  }, 60_000)
})
