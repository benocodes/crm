import { afterEach, describe, expect, it } from 'vitest'
import { metaDoc } from './test/fixtures.js'
import { KEY, SERVER, fakeInstance, json, rig } from './test/harness.js'

// [[AGT701]] D13 (next-step line, planner 701.35): after a successful `vibase agents create` the CLI names both routes to a credential on stderr, with the created agent's real id.
// Stdout (the JSON) and the exit code are the answer's alone; nothing of the hint is printed for a refused create. `invitations create --agent-id` is the generated command.
const AGENT_ID = '0190b2c4-0000-7000-8000-00000000a1d1'
const rigs: ReturnType<typeof rig>[] = []
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})

const withAgents = () => {
  const doc = metaDoc()
  const body = (props: Record<string, unknown>) => ({
    required: true,
    content: { 'application/json': { schema: { type: 'object', properties: props, additionalProperties: false } } },
  })
  doc.paths['/meta/v1/agents'] = {
    post: {
      operationId: 'agents.create',
      summary: 'Create an agent',
      requestBody: body({ name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } } }),
      responses: { '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object' } } } } },
    },
  }
  doc.paths['/meta/v1/invitations'] = {
    post: {
      operationId: 'invitations.create',
      summary: 'Invite',
      requestBody: body({
        email: { type: 'string' },
        role: { type: 'string', enum: ['owner', 'member', 'agent'] },
        agent_id: { type: 'string', format: 'uuid' },
      }),
      responses: { '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object' } } } } },
    },
  }
  return doc
}
const setup = (agentsCreate: () => Response) => {
  const inst = fakeInstance({
    meta: withAgents(),
    routes: (req) => {
      const path = new URL(req.url).pathname
      if (path === '/meta/v1/agents' && req.method === 'POST') return agentsCreate()
      if (path === '/meta/v1/invitations' && req.method === 'POST') return json({ id: 'i1' }, 201)
      return undefined
    },
  })
  const r = rig({ fetch: inst.fetch })
  rigs.push(r)
  return r
}
const login = async (r: ReturnType<typeof rig>) =>
  expect((await r.run(['login', '--api-key', '--server', SERVER], { stdin: KEY + '\n' })).code).toBe(0)

const ANSWER = { id: AGENT_ID, name: 'sales-agent', scopes: ['contacts:read'] }

describe('agents create: the next step (AGT701 D13)', () => {
  it('stderr names both routes with the created agent id; stdout is the JSON answer alone; exit 0', async () => {
    const r = setup(() => json(ANSWER, 201))
    await login(r)
    const res = await r.run(['agents', 'create', '--name', 'sales-agent'])
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual(ANSWER)
    expect(res.stdout).not.toContain('api-keys')
    expect(res.stdout).not.toContain('invitations')
    expect(res.stderr).toContain(`vibase api-keys create --agent-id ${AGENT_ID}`)
    expect(res.stderr).toContain(`vibase invitations create --agent-id ${AGENT_ID} --email <agent-email>`)
  })

  it('stdout is byte-identical to the answer printed on its own', async () => {
    const r = setup(() => json(ANSWER, 201))
    await login(r)
    const created = await r.run(['agents', 'create', '--name', 'sales-agent'])
    expect(created.stdout).toBe(JSON.stringify(ANSWER) + '\n')
  })

  it('a refused create prints none of the hint', async () => {
    const r = setup(() => json({ error: { code: 'validation_error', message: 'name is required' } }, 400))
    await login(r)
    const res = await r.run(['agents', 'create', '--name', 'x'])
    expect(res.code).toBe(1)
    expect(res.stderr).not.toContain('api-keys create')
    expect(res.stderr).not.toContain('invitations create')
  })

  it('no other command prints the hint', async () => {
    const r = setup(() => json(ANSWER, 201))
    await login(r)
    const res = await r.run(['invitations', 'create', '--email', 'a@x.test', '--role', 'member'])
    expect(res.stderr).not.toContain('api-keys create')
  })
})

describe('invitations create --agent-id (the generated flag, no --role)', () => {
  it('sends agent_id and no role', async () => {
    let sent: unknown
    const inst = fakeInstance({
      meta: withAgents(),
      routes: async (req) => {
        if (new URL(req.url).pathname === '/meta/v1/invitations') {
          sent = await req.json()
          return json({ id: 'i1' }, 201)
        }
        return json({ error: { code: 'not_found', message: 'no such route' } }, 404)
      },
    })
    const r2 = rig({ fetch: inst.fetch })
    rigs.push(r2)
    await login(r2)
    const res = await r2.run(['invitations', 'create', '--agent-id', AGENT_ID, '--email', 'a@x.test'])
    expect(res.code, res.stderr).toBe(0)
    expect(sent).toEqual({ agent_id: AGENT_ID, email: 'a@x.test' })
  })
})
