export { loadDocuments } from './documents.js'
export const GENERATE_COMMAND = 'pnpm -C packages/sdk generate'
export type Documents = { api: unknown; meta: unknown }
export async function generateSdk(_documents: Documents): Promise<{ operations: string; types: string }> {
  throw new Error('not implemented')
}
export function memberNames(_operationId: string): { namespace: string; method: string } {
  throw new Error('not implemented')
}
