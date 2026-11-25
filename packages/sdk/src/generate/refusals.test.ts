import { describe, expect, it } from 'vitest'
import { generateSdk, memberNames } from './index.js'

// DX603 D4, D5, P3: the generator's refusals, proven over small synthetic documents (the real ones trigger none).
const ok = {
  200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: {} } } } },
}
const documents = (
  api: Record<string, Record<string, unknown>>,
  meta: Record<string, Record<string, unknown>> = {},
) => ({
  api: { openapi: '3.1.0', info: { title: 'a', version: '1' }, paths: api },
  meta: { openapi: '3.1.0', info: { title: 'm', version: '1' }, paths: meta },
})
const get = (operationId: string, extra: Record<string, unknown> = {}) => ({
  get: { operationId, responses: ok, ...extra },
})
const post = (operationId: string, schema: unknown, parameters: unknown[] = []) => ({
  post: {
    operationId,
    parameters,
    requestBody: { required: true, content: { 'application/json': { schema } } },
    responses: ok,
  },
})

describe('DX603 D4 names', () => {
  it.each([
    ['action_requests.approve', 'actionRequests', 'approve'],
    ['deals.move_stage', 'deals', 'moveStage'],
    ['contacts.property_keys', 'contacts', 'propertyKeys'],
    ['contacts.list', 'contacts', 'list'],
  ])('%s maps to %s.%s', (id, namespace, method) => {
    expect(memberNames(id)).toEqual({ namespace, method })
  })
})

describe('DX603 generation refusals', () => {
  it('refuses two operation ids that map to one member, naming both', async () => {
    const error = await generateSdk(documents({ '/a': get('a_b.c'), '/b': get('aB.c') })).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('a_b.c')
    expect(error.message).toContain('aB.c')
  })

  it('refuses the same id in both documents, naming it', async () => {
    const error = await generateSdk(documents({ '/a': get('x.list') }, { '/b': get('x.list') })).catch((e) => e)
    expect(error.message).toContain('x.list')
  })

  it.each(['all', 'propose'])('refuses a method named %s, naming the operation', async (name) => {
    const error = await generateSdk(documents({ '/a': get(`things.${name}`) })).catch((e) => e)
    expect(error.message).toContain(`things.${name}`)
    expect(error.message).toContain(name)
  })

  it('refuses a request body that is not a JSON object, naming the operation', async () => {
    const error = await generateSdk(
      documents({ '/a': post('things.bulk', { type: 'array', items: { type: 'string' } }) }),
    ).catch((e) => e)
    expect(error.message).toContain('things.bulk')
    expect(error.message).toMatch(/object/)
  })

  it('refuses a field named in both the path or query and the body, naming the field', async () => {
    const pathAndBody = await generateSdk(
      documents({
        '/a/{id}': post('things.update', { type: 'object', properties: { id: { type: 'string' } } }, [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ]),
      }),
    ).catch((e) => e)
    expect(pathAndBody.message).toContain('things.update')
    expect(pathAndBody.message).toContain('"id"')
    const queryAndBody = await generateSdk(
      documents({
        '/b': post('things.make', { type: 'object', properties: { limit: { type: 'integer' } } }, [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ]),
      }),
    ).catch((e) => e)
    expect(queryAndBody.message).toContain('things.make')
    expect(queryAndBody.message).toContain('"limit"')
  })

  it('accepts a clean document (the refusals are not blanket)', async () => {
    const generated = await generateSdk(documents({ '/a': get('things.list'), '/b': get('other_things.get') }))
    expect(generated.operations).toContain("'things.list'")
    expect(generated.operations).toContain('otherThings')
    expect(generated.types).toContain("'other_things.get'")
  })
})

describe('DX604 D5 __c namespaces', () => {
  it.each([
    ['projects__c.list', 'projects__c', 'list'],
    ['projects__c.move_stage', 'projects__c', 'moveStage'],
    ['action_requests.approve', 'actionRequests', 'approve'],
    ['deals.move_stage', 'deals', 'moveStage'],
    ['contacts.property_keys', 'contacts', 'propertyKeys'],
  ])('%s maps to %s.%s', (id, namespace, method) => {
    expect(memberNames(id)).toEqual({ namespace, method })
  })

  it('a method part ending in __c is still camelCased: only the namespace keeps its key', () => {
    expect(memberNames('contacts.set_tier__c')).toEqual({ namespace: 'contacts', method: 'setTierC' })
  })
})

describe('DX604 D4 origin-relative paths', () => {
  it('accepts a path with a single leading slash', async () => {
    await expect(generateSdk(documents({ '/api/v1/a': get('a.list') }))).resolves.toBeDefined()
  })

  it.each([
    ['an absolute URL', 'https://evil.example/api/v1/a'],
    ['a // host', '//evil.example/api/v1/a'],
    ['a relative path', 'api/v1/a'],
  ])('refuses %s, naming the operation', async (_label, path) => {
    const error = await generateSdk(documents({ [path]: get('a.list') })).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error.message)).toContain('a.list')
    expect(String(error.message)).toContain(path)
  })
})
