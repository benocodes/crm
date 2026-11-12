import { mkdir, writeFile } from 'node:fs/promises';
import { createApp, openApiPath, SURFACES } from '@vault/api';

// Use the production router's public documents. Generating a contract must never
// query a database, read credentials, or contact a running instance.
const app = createApp({
  workspace: {},
  storage: () => ({
    kind: 'd1',
    // Public OpenAPI routes need a binding object but never use its tenant identity.
    organizationId: '00000000-0000-7000-8000-000000000000',
    authProvider: '',
    authOrgId: '',
    runtime: {
      dialect: 'd1',
      maxSetSize: 0,
      execute: async () => { throw new Error('OpenAPI generation must not query storage'); },
    },
  }),
});

const directory = new URL('../public/openapi/', import.meta.url);
await mkdir(directory, { recursive: true });

for (const surface of SURFACES) {
  const response = await app.request(openApiPath(surface));
  if (!response.ok) throw new Error(`Cannot generate ${surface} OpenAPI: HTTP ${response.status}`);
  const document = await response.json();
  if (document.openapi !== '3.1.0' || !Object.keys(document.paths ?? {}).length) {
    throw new Error(`Invalid or empty ${surface} OpenAPI document`);
  }
  await writeFile(new URL(`${surface}.json`, directory), JSON.stringify(document, null, 2) + '\n');
  console.log(`Generated ${surface} OpenAPI: ${Object.keys(document.paths).length} paths`);
}
