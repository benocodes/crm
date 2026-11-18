import { describe, expect, it } from 'vitest'
import { createApp } from '../rest/app.js'
import { createVibaseRegistry } from '../operations.js'
import { deriveTools } from '../mcp/tools.js'
import { openApiPath } from '../surfaces.js'
import { coldStorage } from '../test/storage.js'

// [[CHN432]] D20 (432.8): the public form route is in no OpenAPI document and no MCP tool.
describe('the form route is not an operation', () => {
  it.each(['api', 'meta'] as const)(
    'the %s OpenAPI document has no path under /f or naming the ingress',
    async (surface) => {
      const res = await createApp({ storage: coldStorage() }).request(openApiPath(surface))
      expect(res.status).toBe(200)
      const doc = (await res.json()) as { paths: Record<string, unknown> }
      expect(Object.keys(doc.paths).filter((p) => p === '/f' || p.startsWith('/f/') || /ingress/i.test(p))).toEqual([])
      expect(JSON.stringify(doc)).not.toMatch(/"\/f\//)
    },
  )

  it('MCP tools/list has no form-ingress tool', () => {
    const names = deriveTools(createVibaseRegistry()).map((t) => t.tool.name)
    expect(names.length).toBeGreaterThan(10)
    expect(names.filter((n) => /ingress|submit|submission/i.test(n))).toEqual([])
    // the five authenticated form operations are there: the absence is of the public route only
    expect(names).toContain('forms_create')
  })
})
