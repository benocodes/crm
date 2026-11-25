import { createApp, openApiPath, SURFACES } from '@vibase/api'

/** The two public OpenAPI documents of the production router, built in-process: no database, no credentials, no network (the docs script's recipe). */
export async function loadDocuments(): Promise<{ api: unknown; meta: unknown }> {
  const app = createApp({
    workspace: {},
    storage: () => ({
      kind: 'd1',
      organizationId: '00000000-0000-7000-8000-000000000000',
      authProvider: '',
      authOrgId: '',
      runtime: {
        dialect: 'd1',
        maxSetSize: 0,
        execute: async () => {
          throw new Error('SDK generation must not query storage')
        },
      },
    }),
  } as Parameters<typeof createApp>[0])
  const out: Record<string, unknown> = {}
  for (const surface of SURFACES) {
    const response = await app.request(openApiPath(surface))
    if (!response.ok) throw new Error(`Cannot read the ${surface} OpenAPI document: HTTP ${response.status}`)
    out[surface] = await response.json()
  }
  return out as { api: unknown; meta: unknown }
}
