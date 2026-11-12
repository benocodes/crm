// A fake vault for the Workflow tests: the five routes the example calls, an in-memory request log, and switches for the failures the tests need.
// It keeps what a real vault answers (a record per get, `{ data, next_cursor }` per list, `{ error: { code, message } }` per refusal).
export interface FakeInteraction {
  id: string
  kind: 'message' | 'reaction'
  direction: 'inbound' | 'outbound'
  thread_id: string | null
  message_id: string | null
  participants: Array<{ identity_id: string; role: 'from' | 'to' | 'cc' | 'bcc' }>
}
export interface FakeRequest {
  method: string
  path: string
  authorization: string | null
  body: unknown
}

export const IDS = {
  interaction: '0192f4a0-0000-7000-8000-000000000001',
  message: '0192f4a0-0000-7000-8000-000000000002',
  thread: '0192f4a0-0000-7000-8000-000000000003',
  connection: '0192f4a0-0000-7000-8000-000000000004',
  otherConnection: '0192f4a0-0000-7000-8000-000000000005',
  mailboxIdentity: '0192f4a0-0000-7000-8000-000000000006',
  otherIdentity: '0192f4a0-0000-7000-8000-000000000007',
  senderIdentity: '0192f4a0-0000-7000-8000-000000000008',
  agent: '0192f4a0-0000-7000-8000-000000000009',
} as const

export class FakeVault {
  requests: FakeRequest[] = []
  interactions = new Map<string, FakeInteraction>()
  messages = new Map<string, { id: string; author: { user_id: string } }>()
  contents = new Map<string, string>()
  connections: Array<{ id: string; identity_id: string; status: string }> = []
  actionRequests: Array<Record<string, unknown>> = []
  /** Answer this route (a `METHOD path-prefix` string) with this status and error code instead. */
  refuse = new Map<string, { status: number; code: string }>()

  constructor(readonly apiKey = 'vk_example_key') {
    this.interactions.set(IDS.interaction, {
      id: IDS.interaction,
      kind: 'message',
      direction: 'inbound',
      thread_id: IDS.thread,
      message_id: IDS.message,
      participants: [
        { identity_id: IDS.senderIdentity, role: 'from' },
        { identity_id: IDS.mailboxIdentity, role: 'to' },
      ],
    })
    this.messages.set(IDS.message, { id: IDS.message, author: { user_id: 'customer@example.test' } })
    this.contents.set(IDS.message, 'Hello, can you send the pricing sheet?')
    this.connections = [{ id: IDS.connection, identity_id: IDS.mailboxIdentity, status: 'active' }]
  }

  /** What `fetch` is given: it also reports the vault's `request_id` per created action request. */
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    this.requests.push({ method, path: url.pathname + url.search, authorization: headers.get('authorization'), body })
    const json = (status: number, value: unknown) => Response.json(value, { status })
    if (headers.get('authorization') !== `Bearer ${this.apiKey}`) return json(401, { error: { code: 'unauthorized', message: 'bad key' } })
    for (const [route, answer] of this.refuse) {
      const [m, prefix] = route.split(' ')
      if (m === method && url.pathname.startsWith(prefix!)) return json(answer.status, { error: { code: answer.code, message: `refused ${route}` } })
    }
    const idOf = (rest: string) => rest.split('/')[0]!
    let m: RegExpExecArray | null
    if ((m = /^\/api\/v1\/interactions\/(.+)$/.exec(url.pathname))) {
      const row = this.interactions.get(idOf(m[1]!))
      return row ? json(200, row) : json(404, { error: { code: 'not_found', message: 'interaction not found' } })
    }
    if ((m = /^\/api\/v1\/messages\/([^/]+)\/content$/.exec(url.pathname))) {
      const content = this.contents.get(m[1]!)
      return content === undefined ? json(404, { error: { code: 'content_unavailable', message: 'none' } }) : json(200, { content_type: 'text/markdown', content, version: 1 })
    }
    if ((m = /^\/api\/v1\/messages\/([^/]+)$/.exec(url.pathname))) {
      const row = this.messages.get(m[1]!)
      return row ? json(200, row) : json(404, { error: { code: 'not_found', message: 'message not found' } })
    }
    if (url.pathname === '/meta/v1/connections' && method === 'GET') return json(200, { data: this.connections, next_cursor: null })
    if (url.pathname === '/api/v1/action-requests' && method === 'GET') {
      const interactionId = url.searchParams.get('interaction_id')
      const data = this.actionRequests.filter((r) => interactionId === null || r.interaction_id === interactionId)
      return json(200, { data, next_cursor: null })
    }
    if (url.pathname === '/api/v1/action-requests' && method === 'POST') {
      const row = { id: `0192f4a0-0000-7000-9000-${String(this.actionRequests.length + 1).padStart(12, '0')}`, status: 'pending', created_by: IDS.agent, interaction_id: body.interaction_id ?? null, ...body }
      this.actionRequests.push(row)
      return json(201, row)
    }
    return json(404, { error: { code: 'not_found', message: `no route ${method} ${url.pathname}` } })
  }

  authorizations(): Set<string | null> {
    return new Set(this.requests.map((r) => r.authorization))
  }
}
