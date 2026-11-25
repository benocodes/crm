import { createApp, openApiPath, SURFACES } from '@vibase/api'

type AppOptions = Parameters<typeof createApp>[0]
export interface WorkspaceDefinitions {
  definitions?: AppOptions['definitions']
  extend?: AppOptions['extend']
}

/** The production router with a storage binding that refuses every query: no database, no credentials, no network (the docs script's recipe). `definitions` and `extend` are a workspace's custom objects and `__c` fields (DX604 D1). */
export function documentsApp(workspace: WorkspaceDefinitions = {}) {
  return createApp({
    workspace: {},
    ...(workspace.definitions ? { definitions: workspace.definitions } : {}),
    ...(workspace.extend ? { extend: workspace.extend } : {}),
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
  } as AppOptions)
}

/** The two public OpenAPI documents of the production router, built in-process. */
export async function loadDocuments(workspace: WorkspaceDefinitions = {}): Promise<{ api: unknown; meta: unknown }> {
  const app = documentsApp(workspace)
  const out: Record<string, unknown> = {}
  for (const surface of SURFACES) {
    const response = await app.request(openApiPath(surface))
    if (!response.ok) throw new Error(`Cannot read the ${surface} OpenAPI document: HTTP ${response.status}`)
    out[surface] = await response.json()
  }
  return out as { api: unknown; meta: unknown }
}
