import { BUILT_IN_PROFILE, type EmitProfile, GENERATE_COMMAND, generateFiles } from './core.js'
import { openapiTranslator } from './translate.js'

export { memberNames } from './analyse.js'
export { loadDocuments } from './documents.js'
export type { EmitProfile }
export { GENERATE_COMMAND }
export { generateWorkspace, type WorkspaceSource } from './workspace.js'
export type Documents = { api: unknown; meta: unknown }

/** A pure function from the two OpenAPI documents to the text of the two generated files (DX603 P3). The profile (DX604 D3) is the built-in one unless a workspace map is being written; the translator is the pinned openapi-typescript (DX694 P1). */
export async function generateSdk(
  documents: Documents,
  profile: EmitProfile = BUILT_IN_PROFILE,
): Promise<{ operations: string; types: string }> {
  return generateFiles(documents, profile, openapiTranslator)
}
