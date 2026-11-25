import { analyseDocuments } from './analyse.js'
import { emitOperations, emitTypes, GENERATE_COMMAND } from './emit.js'

export { memberNames } from './analyse.js'
export { loadDocuments } from './documents.js'
export { GENERATE_COMMAND }
export type Documents = { api: unknown; meta: unknown }

/** A pure function from the two OpenAPI documents to the text of the two generated files (DX603 P3). */
export async function generateSdk(documents: Documents): Promise<{ operations: string; types: string }> {
  const ops = analyseDocuments(documents)
  return { operations: emitOperations(ops), types: await emitTypes(documents, ops) }
}
