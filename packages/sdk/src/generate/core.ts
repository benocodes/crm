import { type Analysed, analyseDocuments } from './analyse.js'
import { type EmitProfile, emitOperations, emitTypes, type Translator } from './emit.js'

// The generator core, exported as `@vibase/sdk/emit` (DX694 D4): imports only relative files and types, so a bundle
// that takes it holds no translator, no compiler and no `@vibase/api`. The caller injects the translator.
export { type Analysed, analyseDocuments, memberNames } from './analyse.js'
export {
  BUILT_IN_PROFILE,
  type EmitProfile,
  emitOperations,
  emitTypes,
  GENERATE_COMMAND,
  type Translator,
} from './emit.js'

/** A pure function from the two OpenAPI documents, a profile and a translator to the text of the two generated files. */
export async function generateFiles(
  documents: { api: unknown; meta: unknown },
  profile: EmitProfile,
  translate: Translator,
): Promise<{ operations: string; types: string }> {
  const ops: Analysed[] = analyseDocuments(documents)
  return { operations: emitOperations(ops, profile), types: await emitTypes(documents, ops, profile, translate) }
}
