import { analyseDocuments } from './analyse.js'
import { BUILT_IN_PROFILE, type EmitProfile, emitOperations, emitTypes, GENERATE_COMMAND } from './emit.js'

export { memberNames } from './analyse.js'
export { loadDocuments } from './documents.js'
export type { EmitProfile }
export { GENERATE_COMMAND }
export { generateWorkspace, type WorkspaceSource } from './workspace.js'
export type Documents = { api: unknown; meta: unknown }

/** A pure function from the two OpenAPI documents to the text of the two generated files (DX603 P3). The profile (DX604 D3) is the built-in one unless a workspace map is being written. */
export async function generateSdk(
  documents: Documents,
  profile: EmitProfile = BUILT_IN_PROFILE,
): Promise<{ operations: string; types: string }> {
  const ops = analyseDocuments(documents)
  return { operations: emitOperations(ops, profile), types: await emitTypes(documents, ops, profile) }
}
