// Type-level tests (DX604 D3, D5, D6): run by `pnpm -C packages/sdk typecheck`, over the committed workspace map generated from
// `generate/fixtures/workspace.schema.json`. Each negative has a positive sibling.
import { createClient } from './index.js'
import { workspaceOperations } from './generate/fixtures/workspace/operations.js'

const vibase = createClient({ url: 'https://api.acme.example', auth: 't', operations: workspaceOperations })

export async function workspaceTypes() {
  // the custom namespace is the key, untranslated
  await vibase.projects__c.list({ name: 'x' })
  // @ts-expect-error the camelCased spelling is not a member
  await vibase.projectsC.list({})

  // a typed range filter on a __c number field
  await vibase.projects__c.list({ budget: { gte: 5000, lt: 9000 } })
  // @ts-expect-error a string on an integer field
  await vibase.projects__c.list({ budget: { gte: 'lots' } })
  // @ts-expect-error like on an integer field
  await vibase.projects__c.list({ budget: { like: '5*' } })

  // an extension enum field is an argument of the built-in write
  await vibase.contacts.update({ id: 'c1', tier__c: 'gold' })
  // @ts-expect-error a value outside the enum
  await vibase.contacts.update({ id: 'c1', tier__c: 'platinum' })
  // @ts-expect-error a __c field nobody declared
  await vibase.contacts.update({ id: 'c1', nope__c: 'gold' })
  // and a filter of contacts.list
  await vibase.contacts.list({ tier__c: 'bronze' })
  // @ts-expect-error a value outside the enum in a filter
  await vibase.contacts.list({ tier__c: 'platinum' })

  // the custom object is proposable, and the proposal's arguments are typed
  await vibase.projects__c.create.propose({ name: 'Site rebuild' }, { reason: 'Kick-off agreed' })
  // @ts-expect-error a stage outside the enum
  await vibase.projects__c.create.propose({ name: 'x', stage: 'someday' }, { reason: 'r' })

  // results carry the __c fields
  const contact = await vibase.contacts.get({ id: 'c1' })
  const tier: 'bronze' | 'gold' | null | undefined = contact.tier__c
  const project = await vibase.projects__c.create({ name: 'x', budget: 5 })
  const stage: 'planned' | 'active' | 'done' | null | undefined = project.stage
  void tier
  void stage

  // .all() iterates custom records
  for await (const p of vibase.projects__c.list.all({ budget: { gte: 1 } })) {
    const n: string = p.name
    void n
  }
}
