// RED STUB (DX604): replaced by the implementation in the green commit.
export type WorkspaceSource = { url: string; fetch?: typeof fetch } | { schema: string; name: string }

export async function generateWorkspace(_options: {
  source: WorkspaceSource
}): Promise<{ operations: string; types: string }> {
  throw new Error('not implemented')
}
