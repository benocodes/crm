import { describe, expect, it } from 'vitest'
import { deriveCommand, deriveCommands, kebab } from './derive.js'
import { parseInvocation, type InvokeIo } from './invoke.js'
import type { Operation } from './types.js'

// [[CORE692]] D1, D3, D4: the semantic part of a `__c` name follows the CLI's kebab rule and the `__c` suffix is kept: the command of `session_recordings__c` is `session-recordings__c`, a flag for `referral_source__c` is `--referral-source__c`, and the request still carries the snake wire name.
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
const recordings = op({
  id: 'session_recordings__c.create',
  method: 'post',
  path: '/api/v1/session-recordings__c',
  body: {
    required: true,
    schema: {
      type: 'object',
      required: ['title'],
      properties: { title: { type: 'string' }, length_seconds: { type: 'integer' }, referral_source__c: { type: 'string' } },
    },
  },
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
  it('a multi-word object is its kebab stem plus __c, for every action', () => {
    expect(deriveCommand(recordings)).toMatchObject({
      resource: 'session-recordings__c',
      action: 'create',
      operationId: 'session_recordings__c.create',
    })
    expect(
      deriveCommand(op({ id: 'session_recordings__c.property_keys', method: 'get', path: '/api/v1/session-recordings__c/property-keys' })),
    ).toMatchObject({ resource: 'session-recordings__c', action: 'property-keys' })
  })
  it('typing the snake spelling still resolves to the command (normalisation through kebab, not an alias)', () => {
    const commands = deriveCommands([recordings])
    const typed = 'session_recordings__c'
    expect(commands.find((c) => c.resource === kebab(typed) && c.action === kebab('create'))?.operationId).toBe(
      'session_recordings__c.create',
    )
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
  it('kebab translates the stem of a __c name, keeps the suffix, and translates a plain one', () => {
    expect(kebab('projects__c')).toBe('projects__c')
    expect(kebab('referral_source__c')).toBe('referral-source__c')
    expect(kebab('session_recordings__c')).toBe('session-recordings__c')
    expect(kebab('session-recordings__c')).toBe('session-recordings__c')
    expect(kebab('blocked_senders')).toBe('blocked-senders')
    expect(kebab('start_date')).toBe('start-date')
  })
})

describe('the flags', () => {
  it('a plain field name keeps the kebab rule', () => {
    const flags = deriveCommand(create).flags.map((f) => f.name)
    expect(flags).toEqual(['name', 'start-date', 'budget'])
  })
  it('a __c parameter is --<kebab stem>__c, query or body', () => {
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
    const multi = deriveCommand(
      op({
        id: 'contacts.list',
        method: 'get',
        path: '/api/v1/contacts',
        parameters: [{ name: 'referral_source__c', in: 'query', required: false, schema: { type: 'string' } }],
      }),
    )
    expect(multi.flags).toEqual([
      expect.objectContaining({ name: 'referral-source__c', prop: 'referral_source__c', where: 'query' }),
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
    expect(withBody.flags.map((f) => [f.name, f.prop])).toEqual([['referral-source__c', 'referral_source__c']])
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
  it('--referral-source__c sends the wire name in the body and the query; --referral_source__c is an unknown flag (D4)', async () => {
    const cmd = deriveCommand(recordings)
    const created = await parseInvocation(cmd, ['--title', 'Call', '--length-seconds', '9', '--referral-source__c', 'web'], io)
    expect(created.body).toEqual({ title: 'Call', length_seconds: 9, referral_source__c: 'web' })
    const list = deriveCommand(
      op({
        id: 'contacts.list',
        method: 'get',
        path: '/api/v1/contacts',
        parameters: [{ name: 'referral_source__c', in: 'query', required: false, schema: { type: 'string' } }],
      }),
    )
    expect((await parseInvocation(list, ['--referral-source__c', 'web'], io)).query).toEqual([['referral_source__c', 'web']])
    await expect(parseInvocation(list, ['--referral_source__c', 'web'], io)).rejects.toThrow(/referral_source__c/)
  })
})
