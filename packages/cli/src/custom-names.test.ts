import { describe, expect, it } from 'vitest'
import { deriveCommand, kebab } from './derive.js'
import { parseInvocation, type InvokeIo } from './invoke.js'
import type { Operation } from './types.js'

// [[CORE315]] D25: a `__c` name is never translated: the command of a custom object is `<key>__c` and a flag for a `__c` name is `--<name>__c`, where a plain name keeps today's kebab rule (`--start-date`).
const io: InvokeIo = { readFile: async () => '', readStdin: async () => '' }
const op = (over: Partial<Operation> & Pick<Operation, 'id' | 'method' | 'path'>): Operation => ({
  source: 'api',
  summary: 's',
  parameters: [],
  body: null,
  binary: false,
  paginated: false,
  ...over,
})
const create = op({
  id: 'projects__c.create',
  method: 'post',
  path: '/api/v1/projects__c',
  body: {
    required: true,
    schema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' }, start_date: { type: 'string' }, budget: { type: 'integer' } },
    },
  },
})

describe('the command of a custom object', () => {
  it('is the object key, untranslated, for every action', () => {
    expect(deriveCommand(create)).toMatchObject({
      resource: 'projects__c',
      action: 'create',
      operationId: 'projects__c.create',
    })
    expect(
      deriveCommand(
        op({
          id: 'projects__c.get',
          method: 'get',
          path: '/api/v1/projects__c/{id}',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        }),
      ),
    ).toMatchObject({
      resource: 'projects__c',
      action: 'get',
    })
  })
  it('a plain resource name still turns _ into -', () => {
    expect(
      deriveCommand(op({ id: 'blocked_senders.list', method: 'get', path: '/meta/v1/blocked-senders' })),
    ).toMatchObject({
      resource: 'blocked-senders',
      action: 'list',
    })
  })
})

describe('the word the user types is read the same way', () => {
  it('kebab leaves a __c name alone and translates a plain one', () => {
    expect(kebab('projects__c')).toBe('projects__c')
    expect(kebab('referral_source__c')).toBe('referral_source__c')
    expect(kebab('blocked_senders')).toBe('blocked-senders')
    expect(kebab('start_date')).toBe('start-date')
  })
})

describe('the flags', () => {
  it('a plain field name keeps the kebab rule', () => {
    const flags = deriveCommand(create).flags.map((f) => f.name)
    expect(flags).toEqual(['name', 'start-date', 'budget'])
  })
  it('a __c parameter is --<name>__c, untranslated, query or body', () => {
    const list = deriveCommand(
      op({
        id: 'projects__c.list',
        method: 'get',
        path: '/api/v1/projects__c',
        parameters: [{ name: 'x__c', in: 'query', required: false, schema: { type: 'integer' } }],
      }),
    )
    expect(list.flags).toEqual([
      expect.objectContaining({ name: 'x__c', prop: 'x__c', where: 'query', type: 'integer' }),
    ])
    const withBody = deriveCommand(
      op({
        id: 'contacts.update',
        method: 'patch',
        path: '/api/v1/contacts/{id}',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        body: { required: false, schema: { type: 'object', properties: { referral_source__c: { type: 'string' } } } },
      }),
    )
    expect(withBody.flags.map((f) => [f.name, f.prop])).toEqual([['referral_source__c', 'referral_source__c']])
  })
  it('the invocation maps --start-date and --x__c to their properties', async () => {
    const created = await parseInvocation(
      deriveCommand(create),
      ['--name', 'Site', '--start-date', '2026-12-01T00:00:00Z', '--budget', '5'],
      io,
    )
    expect(created.body).toEqual({ name: 'Site', start_date: '2026-12-01T00:00:00Z', budget: 5 })
    const list = deriveCommand(
      op({
        id: 'projects__c.list',
        method: 'get',
        path: '/api/v1/projects__c',
        parameters: [{ name: 'x__c', in: 'query', required: false, schema: { type: 'integer' } }],
      }),
    )
    expect((await parseInvocation(list, ['--x__c', '7'], io)).query).toEqual([['x__c', '7']])
  })
})
