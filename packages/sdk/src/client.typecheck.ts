// Type-level tests (DX603 D1, D12): run by `pnpm -C packages/sdk typecheck`. Each negative carries a positive sibling at
// the call site; a negative that stops erroring turns `@ts-expect-error` into TS2578.
import { type Client, createClient, type OperationTable } from './index.js'

const vibase = createClient({ url: 'https://api.acme.example', auth: 't' })

export async function typeTests() {
  // unknown namespace and method
  await vibase.contacts.list()
  // @ts-expect-error unknown namespace
  await vibase.nothing.list()
  // @ts-expect-error unknown method
  await vibase.contacts.nothing()

  // a required argument is required (get needs id); an optional-only operation takes none
  await vibase.contacts.get({ id: 'c1' })
  // @ts-expect-error missing required argument
  await vibase.contacts.get({})
  // @ts-expect-error missing the arguments object
  await vibase.contacts.get()

  // a wrong argument type
  await vibase.contacts.list({ limit: 10 })
  // @ts-expect-error limit is a number
  await vibase.contacts.list({ limit: 'ten' })

  // the result type: a field the API returns reads, one it does not is an error
  const contact = await vibase.contacts.get({ id: 'c1' })
  const name: string | null = contact.name
  // @ts-expect-error no such field on a contact
  contact.nope
  void name

  // a multi-word method and namespace
  await vibase.deals.moveStage({ id: 'd1', stage_id: 's1' })
  await vibase.actionRequests.approve({ id: 'a1' })

  // a 204 resolves undefined, a binary operation resolves the Response
  const gone: undefined = await vibase.tasks.delete({ id: 't1' })
  const response: Response = await vibase.files.content({ id: 'f1' })
  void gone
  void response

  // the signal option
  await vibase.contacts.get({ id: 'c1' }, { signal: new AbortController().signal })
  // @ts-expect-error not a call option
  await vibase.contacts.get({ id: 'c1' }, { retries: 3 })
}

// createClient({ operations }) infers a non-default map from a passed table.
type Pong = {
  'pings.pong': { namespace: 'pings'; method: 'pong'; args: { n: number }; result: { echoed: number }; proposable: false; paginated: false }
}
declare const table: OperationTable<Pong>

export async function inferenceTests() {
  const custom = createClient({ url: 'https://x.example', auth: 't', operations: table })
  const reply = await custom.pings.pong({ n: 1 })
  const echoed: number = reply.echoed
  void echoed
  // @ts-expect-error pong takes a number
  await custom.pings.pong({ n: 'one' })
  // @ts-expect-error the built-ins are not in this map
  await custom.contacts.list()
  // @ts-expect-error pong is not a built-in
  await vibase.pings.pong({ n: 1 })
  const typed: Client<Pong> = custom
  void typed
}
