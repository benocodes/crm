// Type-level tests (DX608 D9, D10, D11): run by `pnpm -C packages/sdk typecheck`. Each negative has a positive sibling.
import { createClient } from './index.js'

const vibase = createClient({ url: 'https://api.acme.example', auth: 't' })

export async function filterTypes() {
  // uuid: eq/neq/in (and is when nullable); gte is not available
  await vibase.contacts.list({ id: { in: ['a', 'b'] } })
  // @ts-expect-error gte on a uuid field
  await vibase.contacts.list({ id: { gte: 'a' } })
  // text: bare string, like
  await vibase.tasks.list({ title: { like: 'a*' } })
  // integer
  await vibase.deals.list({ amount_minor: { gte: 1, lt: 10 } })
  // @ts-expect-error a string on an integer field
  await vibase.deals.list({ amount_minor: 'five' })
  // @ts-expect-error a string on an integer field in an operator
  await vibase.deals.list({ amount_minor: { gt: '5' } })
  // is only where the field is nullable
  await vibase.tasks.list({ assignee_id: { is: null } })
  // @ts-expect-error is on a field without it
  await vibase.contacts.list({ created_by: { is: null } })
  // like on a non-text field
  // @ts-expect-error like on a uuid field
  await vibase.contacts.list({ id: { like: 'a*' } })
  // @ts-expect-error like on an integer field
  await vibase.deals.list({ amount_minor: { like: '1*' } })
  // timestamp: string or Date
  await vibase.tasks.list({ created_at: { gte: new Date(), lt: '2026-01-01T00:00:00Z' } })
  // @ts-expect-error a number on a timestamp field
  await vibase.tasks.list({ created_at: { gte: 5 } })
  // boolean
  await vibase.forms.list({ enabled: true })
  await vibase.forms.list({ enabled: { neq: false } })
  // @ts-expect-error a string on a boolean field
  await vibase.forms.list({ enabled: 'yes' })
  // @ts-expect-error gt on a boolean field
  await vibase.forms.list({ enabled: { gt: true } })
  // not carries operators of the field too
  await vibase.tasks.list({ status: { not: { in: ['a'] } } })
  // @ts-expect-error not on not
  await vibase.tasks.list({ status: { not: { not: { eq: 'a' } } } })
  // non-filter parameters keep their types
  await vibase.tasks.list({ limit: 5 })
  // @ts-expect-error limit is a number
  await vibase.tasks.list({ limit: '5' })
}

export async function memberTypes() {
  // .all only on paginated operations; the item type is read
  for await (const task of vibase.tasks.list.all({ limit: 2 })) {
    const title: string = task.title
    void title
    // @ts-expect-error no such field on a task
    task.nope
  }
  // @ts-expect-error contacts.get is not paginated
  vibase.contacts.get.all({ id: 'x' })

  // .propose only on proposable operations
  const request = await vibase.tasks.update.propose({ id: 'x', title: 't' }, { reason: 'why' })
  const op: 'tasks.update' = request.operation
  void op
  // @ts-expect-error operation is narrowed to tasks.update
  const wrong: 'tasks.delete' = request.operation
  void wrong
  const id: string = request.arguments.id
  void id
  // @ts-expect-error tasks.list is not proposable
  vibase.tasks.list.propose({}, { reason: 'r' })
  // @ts-expect-error a proposal needs a reason
  await vibase.tasks.update.propose({ id: 'x' }, {})
  // the arguments are typed by the operation
  // @ts-expect-error title is a string
  await vibase.tasks.update.propose({ id: 'x', title: 5 }, { reason: 'r' })
}
