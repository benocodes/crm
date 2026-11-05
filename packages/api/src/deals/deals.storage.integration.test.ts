import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { openD1Engine, type Engine } from '../test/engines.js'
import { assocKit, type AssocKit, type Rec } from '../test/assoc-kit.js'

// CORE130 on D1 (the oracle): pipelines, stages and deals through the registry's own operations (D21): names and validation, the
// stage reference and pipeline consistency (D9), `deals.move_stage` and `closed_at` (D10, D11), events (D12), the derived `status` (D8),
// the delete holds (D13) and the list filters (D15).
let e: Engine
let a: AssocKit
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  a = assocKit(e)
})

type Opts = Parameters<AssocKit['call']>[2]
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const pipeline = (name = 'Sales', opts?: Opts): Promise<Rec> => a.call('pipelines.create', { body: { name } }, opts)
const stage = (p: Rec, name: string, kind = 'open', position = 10, opts?: Opts): Promise<Rec> =>
  a.call('pipeline_stages.create', { body: { pipeline_id: p.id, name, kind, position } }, opts)
const deal = (s: Rec, over: Rec = {}, opts?: Opts): Promise<Rec> => a.call('deals.create', { body: { name: 'Acme - pilot', stage_id: s.id, ...over } }, opts)
const move = (d: Rec, s: Rec | string, opts?: Opts): Promise<Rec> => a.call('deals.move_stage', { params: { id: d.id }, body: { stage_id: typeof s === 'string' ? s : s.id } }, opts)
const fail = async (name: string, input: Parameters<AssocKit['fail']>[1], opts?: Parameters<AssocKit['fail']>[2]) => {
  const err = await a.fail(name, input, opts)
  return [err.status, err.code, err.message] as const
}
/** The setup most cases need: a pipeline with Researched/Contacted (open), Won and Lost. */
const world = async () => {
  const p = await pipeline()
  return { p, researched: await stage(p, 'Researched', 'open', 10), contacted: await stage(p, 'Contacted', 'open', 20), won: await stage(p, 'Won', 'won', 90), lost: await stage(p, 'Lost', 'lost', 100) }
}
const events = async (prefix: string) => (await e.rows('events')).filter((x) => String(x.type).startsWith(prefix)).sort((x, y) => String(x.id).localeCompare(String(y.id)))
const ids = (page: { data: Rec[] }) => page.data.map((r) => r.id as string).sort()
const live = async (table: string) => (await e.rows(table)).filter((r) => r.deleted_at === null)

describe('pipelines and stages: validation, names and create-only fields (D3, D4, D6)', () => {
  it('creates a pipeline and a stage in the record shape, trimmed, attributed to the caller', async () => {
    const p = await pipeline('  Prospecting  ')
    expect(p).toMatchObject({ organization_id: e.organizationId, created_by: e.userId, name: 'Prospecting' })
    expect(Object.keys(p).sort()).toEqual(['created_at', 'created_by', 'id', 'name', 'organization_id', 'updated_at'])
    const s = await stage(p, '  Researched ', 'open', 10)
    expect(s).toMatchObject({ pipeline_id: p.id, name: 'Researched', kind: 'open', position: 10, created_by: e.userId })
    expect(Object.keys(s).sort()).toEqual(['created_at', 'created_by', 'id', 'kind', 'name', 'organization_id', 'pipeline_id', 'position', 'updated_at'])
  })

  it.each([
    ['pipelines.create', 'a whitespace name', { name: '  ' }],
    ['pipelines.create', 'a name of 101 characters', { name: 'x'.repeat(101) }],
    ['pipelines.create', 'an unknown key', { name: 'n', color: 'red' }],
    ['pipelines.create', 'created_by', { name: 'n', created_by: uuidv7() }],
  ])('%s refuses %s with 400 validation_error and writes nothing', async (op, _what, body) => {
    const err = await a.fail(op, { body })
    expect([err.status, err.code]).toEqual([400, 'validation_error'])
    expect(await e.rows('pipelines')).toEqual([])
    expect(await e.rows('events')).toEqual([])
  })

  it('stage input: kind in open/won/lost, position an integer >= 0 and required, name 1-100, unknown keys refused', async () => {
    const p = await pipeline()
    const bad = [
      { name: 'S', kind: 'closed', position: 1 },
      { name: 'S', kind: 'open' },
      { name: 'S', kind: 'open', position: -1 },
      { name: 'S', kind: 'open', position: 1.5 },
      { name: '', kind: 'open', position: 1 },
      { name: 'x'.repeat(101), kind: 'open', position: 1 },
      { name: 'S', kind: 'open', position: 1, probability: 50 },
      { kind: 'open', position: 1 },
    ]
    for (const body of bad) {
      const err = await a.fail('pipeline_stages.create', { body: { pipeline_id: p.id, ...body } })
      expect([err.status, err.code], JSON.stringify(body)).toEqual([400, 'validation_error'])
    }
    expect((await a.fail('pipeline_stages.create', { body: { name: 'S', kind: 'open', position: 1 } })).code).toBe('validation_error') // no pipeline_id
    expect(await e.rows('pipeline_stages')).toEqual([])
    expect((await stage(p, 'x'.repeat(100), 'open', 0)).position).toBe(0) // the bounds themselves
  })

  it('a stage needs a live pipeline: unknown or deleted is 400 invalid_reference', async () => {
    const p = await pipeline()
    const gone = await pipeline('Gone')
    await a.call('pipelines.delete', { params: { id: gone.id } })
    for (const pipeline_id of [uuidv7(), gone.id]) {
      const err = await a.fail('pipeline_stages.create', { body: { pipeline_id, name: 'S', kind: 'open', position: 1 } })
      expect([err.status, err.code]).toEqual([400, 'invalid_reference'])
    }
    expect(await live('pipeline_stages')).toEqual([])
    expect(await live('pipelines')).toHaveLength(1)
    expect((await live('pipelines'))[0]!.id).toBe(p.id)
  })

  it('update takes name and position only; kind and pipeline_id are create-only (D3)', async () => {
    const w = await world()
    const other = await pipeline('Other')
    const renamed = await a.call('pipeline_stages.update', { params: { id: w.researched.id }, body: { name: 'Sourced', position: 5 } })
    expect(renamed).toMatchObject({ name: 'Sourced', position: 5, kind: 'open', pipeline_id: w.p.id })
    for (const body of [{ kind: 'won' }, { pipeline_id: other.id }, { name: 'ok', kind: 'lost' }]) {
      const err = await a.fail('pipeline_stages.update', { params: { id: w.researched.id }, body })
      expect([err.status, err.code], JSON.stringify(body)).toEqual([400, 'validation_error'])
      expect(err.message).toMatch(/kind|pipeline_id/)
    }
    expect(await a.call('pipeline_stages.get', { params: { id: w.researched.id } })).toMatchObject({ kind: 'open', pipeline_id: w.p.id, name: 'Sourced' })
  })

  it('positions are not unique: two stages may share one (a reorder is one update per moved stage)', async () => {
    const p = await pipeline()
    const x = await stage(p, 'X', 'open', 10)
    const y = await stage(p, 'Y', 'open', 20)
    const moved = await a.call('pipeline_stages.update', { params: { id: y.id }, body: { position: 10 } })
    expect(moved.position).toBe(10)
    expect((await a.call('pipeline_stages.get', { params: { id: x.id } })).position).toBe(10)
  })

  it('pipeline names are unique among live pipelines, ignoring case: 409 pipeline_exists naming the first id', async () => {
    const first = await pipeline('Sales')
    const mark = (await e.rows('events')).length
    for (const name of ['sales', '  SALES ']) {
      const [status, code, message] = await fail('pipelines.create', { body: { name } })
      expect([status, code]).toEqual([409, 'pipeline_exists'])
      expect(message).toContain(first.id)
    }
    expect(await e.rows('pipelines')).toHaveLength(1)
    expect((await e.rows('events')).length).toBe(mark)
    const second = await pipeline('Other')
    const [status, code, message] = await fail('pipelines.update', { params: { id: second.id }, body: { name: 'sales' } })
    expect([status, code]).toEqual([409, 'pipeline_exists'])
    expect(message).toContain(first.id)
    expect((await a.call('pipelines.update', { params: { id: first.id }, body: { name: 'SALES' } })).name).toBe('SALES') // its own name, another case
  })

  it('stage names are unique within one pipeline only: 409 stage_exists; the same name in another pipeline is fine', async () => {
    const p = await pipeline('A')
    const q = await pipeline('B')
    const first = await stage(p, 'Won', 'won', 90)
    const [status, code, message] = await fail('pipeline_stages.create', { body: { pipeline_id: p.id, name: 'won', kind: 'won', position: 91 } })
    expect([status, code]).toEqual([409, 'stage_exists'])
    expect(message).toContain(first.id)
    expect((await stage(q, 'WON', 'won', 90)).pipeline_id).toBe(q.id)
    const other = await stage(p, 'Lost', 'lost', 100)
    const upd = await fail('pipeline_stages.update', { params: { id: other.id }, body: { name: 'WON' } })
    expect([upd[0], upd[1]]).toEqual([409, 'stage_exists'])
    expect(upd[2]).toContain(first.id)
    expect((await a.call('pipeline_stages.update', { params: { id: first.id }, body: { name: 'WON' } })).name).toBe('WON')
  })

  it('a deleted name is reusable: with no live row to compare the create succeeds (empty state)', async () => {
    const p = await pipeline('Sales')
    const s = await stage(p, 'Won', 'won', 90)
    await a.call('pipeline_stages.delete', { params: { id: s.id } })
    expect((await stage(p, 'won', 'won', 90)).id).not.toBe(s.id)
    await a.call('pipelines.delete', { params: { id: p.id } })
    expect((await pipeline('sales')).id).not.toBe(p.id)
  })

  it('the partial unique indexes refuse a racing duplicate at commit as 409 conflict, not 500', async () => {
    e.betweenPlanAndCommit(async () => void (await pipeline('Raced')))
    expect((await fail('pipelines.create', { body: { name: 'raced' } })).slice(0, 2)).toEqual([409, 'conflict'])
    expect(await e.rows('pipelines')).toHaveLength(1)
    const p = await pipeline('P')
    e.betweenPlanAndCommit(async () => void (await stage(p, 'Raced stage')))
    expect((await fail('pipeline_stages.create', { body: { pipeline_id: p.id, name: 'raced STAGE', kind: 'open', position: 1 } })).slice(0, 2)).toEqual([409, 'conflict'])
    expect(await e.rows('pipeline_stages')).toHaveLength(1)
  })
})

describe('deal validation (D7, D9)', () => {
  it('creates a deal in the record shape: pipeline_id is the stage\'s, status is the stage kind, closed_at null', async () => {
    const w = await world()
    const d = await deal(w.researched, { amount_minor: 125000, currency: 'usd', expected_close_date: '2026-12-31', owner_id: e.agentId })
    expect(d).toMatchObject({
      organization_id: e.organizationId, name: 'Acme - pilot', pipeline_id: w.p.id, stage_id: w.researched.id, status: 'open',
      amount_minor: 125000, currency: 'USD', expected_close_date: '2026-12-31', owner_id: e.agentId, closed_at: null, created_by: e.userId,
    })
    expect(Object.keys(d).sort()).toEqual(['amount_minor', 'closed_at', 'created_at', 'created_by', 'currency', 'expected_close_date', 'id', 'name', 'organization_id', 'owner_id', 'pipeline_id', 'stage_id', 'status', 'updated_at'])
    const bare = await deal(w.researched, { name: '  Bare ' })
    expect(bare).toMatchObject({ name: 'Bare', amount_minor: null, currency: null, expected_close_date: null, owner_id: null })
  })

  it('pipeline_id is the stage\'s pipeline whichever pipeline it is, and pipeline_id in create input is 400', async () => {
    const w = await world()
    const q = await pipeline('Other')
    const qs = await stage(q, 'Start', 'open', 1)
    expect((await deal(w.contacted)).pipeline_id).toBe(w.p.id)
    expect((await deal(qs)).pipeline_id).toBe(q.id)
    const err = await a.fail('deals.create', { body: { name: 'D', stage_id: w.researched.id, pipeline_id: q.id } })
    expect([err.status, err.code]).toEqual([400, 'validation_error'])
    expect(await live('deals')).toHaveLength(2)
  })

  it('the stage reference: an unknown stage, a deleted stage and another organisation\'s stage are each 400 invalid_reference', async () => {
    const w = await world()
    const gone = await stage(w.p, 'Gone', 'open', 50)
    await a.call('pipeline_stages.delete', { params: { id: gone.id } })
    // The database holds one organisation; a second one is set up directly because no operation can create it (a D21 exception).
    const org = uuidv7()
    await e.d1!.prepare('INSERT INTO organizations (id, created_at, updated_at, name) VALUES (?, ?, ?, ?)').bind(org, '2026-10-22T08:00:00.000Z', '2026-10-22T08:00:00.000Z', 'Other org').run()
    const fp = await e.insert('pipelines', { organization_id: org, name: 'Foreign' })
    const fs = await e.insert('pipeline_stages', { organization_id: org, pipeline_id: fp.id, name: 'Foreign stage', kind: 'open', position: 1 })
    for (const stage_id of [uuidv7(), gone.id, fs.id]) {
      const create = await a.fail('deals.create', { body: { name: 'D', stage_id } })
      expect([create.status, create.code], `create into ${stage_id}`).toEqual([400, 'invalid_reference'])
      const d = await deal(w.researched)
      const moved = await a.fail('deals.move_stage', { params: { id: d.id }, body: { stage_id } })
      expect([moved.status, moved.code], `move to ${stage_id}`).toEqual([400, 'invalid_reference'])
    }
    expect((await live('deals')).every((r) => r.stage_id === w.researched.id)).toBe(true)
  })

  it('a stage deleted between plan and commit aborts deals.create: nothing written, no event', async () => {
    const w = await world()
    const spare = await stage(w.p, 'Spare', 'open', 50)
    const mark = (await e.rows('events')).length
    e.betweenPlanAndCommit(async () => void (await a.call('pipeline_stages.delete', { params: { id: spare.id } })))
    const err = await a.fail('deals.create', { body: { name: 'D', stage_id: spare.id } })
    expect(err.status).toBe(409)
    expect(await e.rows('deals')).toEqual([])
    expect((await e.rows('events')).slice(mark).map((x) => x.type)).toEqual(['pipeline_stage.deleted']) // the racing delete's own event, no deal event
  })

  it('a stage deleted between plan and commit aborts deals.move_stage: the deal is untouched, no deal event', async () => {
    const w = await world()
    const spare = await stage(w.p, 'Spare', 'open', 50)
    const d = await deal(w.researched)
    e.betweenPlanAndCommit(async () => void (await a.call('pipeline_stages.delete', { params: { id: spare.id } })))
    const err = await a.fail('deals.move_stage', { params: { id: d.id }, body: { stage_id: spare.id } })
    expect(err.status).toBe(409)
    expect(await a.call('deals.get', { params: { id: d.id } })).toEqual(d)
    expect((await events('deal.')).map((x) => x.type)).toEqual(['deal.created'])
  })

  it('owner_id must be a live principal of the organisation (400 invalid_reference); null clears it', async () => {
    const w = await world()
    const err = await a.fail('deals.create', { body: { name: 'D', stage_id: w.researched.id, owner_id: uuidv7() } })
    expect([err.status, err.code]).toEqual([400, 'invalid_reference'])
    const d = await deal(w.researched, { owner_id: e.userId })
    expect((await a.call('deals.update', { params: { id: d.id }, body: { owner_id: null } })).owner_id).toBeNull()
  })

  it('the amount needs a currency, judged on the resulting row: on create and on partial updates', async () => {
    const w = await world()
    const bad = async (name: string, input: Parameters<AssocKit['fail']>[1]) => {
      const err = await a.fail(name, input)
      expect([err.status, err.code], JSON.stringify(input)).toEqual([400, 'validation_error'])
      expect(err.message).toMatch(/currency/)
    }
    await bad('deals.create', { body: { name: 'D', stage_id: w.researched.id, amount_minor: 100 } })
    await bad('deals.create', { body: { name: 'D', stage_id: w.researched.id, amount_minor: 100, currency: null } })
    expect(await live('deals')).toEqual([])
    expect((await deal(w.researched, { currency: 'EUR' })).amount_minor).toBeNull() // a currency without an amount is allowed
    const plain = await deal(w.researched, { name: 'Plain' })
    await bad('deals.update', { params: { id: plain.id }, body: { amount_minor: 5 } }) // sets only the amount on a row with no currency
    const priced = await deal(w.researched, { name: 'Priced', amount_minor: 5, currency: 'USD' })
    await bad('deals.update', { params: { id: priced.id }, body: { currency: null } }) // clears the currency under an amount
    expect(await a.call('deals.update', { params: { id: priced.id }, body: { amount_minor: 7 } })).toMatchObject({ amount_minor: 7, currency: 'USD' })
    expect(await a.call('deals.update', { params: { id: priced.id }, body: { amount_minor: null, currency: null } })).toMatchObject({ amount_minor: null, currency: null })
    expect(await a.call('deals.update', { params: { id: plain.id }, body: { amount_minor: 9, currency: 'gbp' } })).toMatchObject({ amount_minor: 9, currency: 'GBP' })
    expect(await a.call('deals.get', { params: { id: priced.id } })).toMatchObject({ amount_minor: null, currency: null })
  })

  it('currency is upper-cased; usd1, ab, a digit, a bad date, a negative, a fraction and 2^53 are refused', async () => {
    const w = await world()
    expect((await deal(w.researched, { amount_minor: 1, currency: 'jpy' })).currency).toBe('JPY')
    expect((await deal(w.researched, { amount_minor: Number.MAX_SAFE_INTEGER, currency: 'JPY' })).amount_minor).toBe(Number.MAX_SAFE_INTEGER)
    expect((await deal(w.researched, { amount_minor: 0, currency: 'JPY', expected_close_date: '2028-02-29' })).expected_close_date).toBe('2028-02-29')
    const mark = (await live('deals')).length
    for (const over of [
      { amount_minor: 1, currency: 'usd1' },
      { amount_minor: 1, currency: 'us' },
      { amount_minor: 1, currency: 'U5D' },
      { amount_minor: -1, currency: 'USD' },
      { amount_minor: 1.5, currency: 'USD' },
      { amount_minor: 2 ** 53, currency: 'USD' },
      { amount_minor: '5', currency: 'USD' },
      { expected_close_date: '2026-02-30' },
      { expected_close_date: '2026-13-01' },
      { expected_close_date: '2026-12-31T00:00:00Z' },
      { expected_close_date: '31/12/2026' },
      { name: '' },
      { name: 'x'.repeat(201) },
    ]) {
      const err = await a.fail('deals.create', { body: { name: 'D', stage_id: w.researched.id, ...over } })
      expect([err.status, err.code], JSON.stringify(over)).toEqual([400, 'validation_error'])
    }
    expect((await live('deals')).length).toBe(mark)
    expect((await deal(w.researched, { name: 'x'.repeat(200) })).name).toHaveLength(200)
  })

  it('unknown keys are 400 on create and update: closed_at, status, pipeline_id and anything else', async () => {
    const w = await world()
    const d = await deal(w.researched)
    for (const extra of [{ closed_at: '2026-01-01T00:00:00.000Z' }, { status: 'won' }, { pipeline_id: w.p.id }, { colour: 'red' }, { created_by: uuidv7() }]) {
      expect((await a.fail('deals.create', { body: { name: 'D', stage_id: w.researched.id, ...extra } })).code, JSON.stringify(extra)).toBe('validation_error')
      if (!('pipeline_id' in extra)) expect((await a.fail('deals.update', { params: { id: d.id }, body: extra })).code, JSON.stringify(extra)).toBe('validation_error')
    }
  })

  it('create-only fields on update: stage_id and pipeline_id are 400 and the message names deals.move_stage', async () => {
    const w = await world()
    const d = await deal(w.researched)
    for (const body of [{ stage_id: w.contacted.id }, { pipeline_id: w.p.id }, { name: 'ok', stage_id: w.contacted.id }]) {
      const err = await a.fail('deals.update', { params: { id: d.id }, body })
      expect([err.status, err.code], JSON.stringify(body)).toEqual([400, 'validation_error'])
      expect(err.message).toContain('deals.move_stage')
    }
    expect(await a.call('deals.get', { params: { id: d.id } })).toEqual(d)
    expect((await events('deal.')).map((x) => x.type)).toEqual(['deal.created'])
  })

  it('the create-only mechanism is general: it refuses on stages and on deals, and still lets every other field through', async () => {
    const w = await world()
    const d = await deal(w.researched)
    const s = (await a.call('pipeline_stages.get', { params: { id: w.researched.id } })) as Rec
    expect((await a.fail('pipeline_stages.update', { params: { id: s.id }, body: { kind: 'lost' } })).code).toBe('validation_error')
    expect((await a.fail('deals.update', { params: { id: d.id }, body: { stage_id: w.won.id } })).code).toBe('validation_error')
    expect((await a.call('pipeline_stages.update', { params: { id: s.id }, body: { name: 'Fine' } })).name).toBe('Fine')
    expect((await a.call('deals.update', { params: { id: d.id }, body: { name: 'Fine' } })).name).toBe('Fine')
  })
})

describe('deals.move_stage and closed_at (D10, D11)', () => {
  it('open -> won sets closed_at to the unit clock; the record shows the new stage and status', async () => {
    const w = await world()
    const d = await deal(w.researched)
    const moved = await move(d, w.won)
    expect(moved).toMatchObject({ id: d.id, stage_id: w.won.id, status: 'won', pipeline_id: w.p.id })
    expect(moved.closed_at).toEqual(expect.any(String))
    expect(moved.closed_at).toBe(moved.updated_at)
  })

  it('won -> lost sets closed_at anew', async () => {
    const w = await world()
    const d = await deal(w.researched)
    const won = await move(d, w.won)
    const lost = await move(d, w.lost)
    expect(lost).toMatchObject({ stage_id: w.lost.id, status: 'lost' })
    expect(lost.closed_at).not.toBe(won.closed_at)
    expect(lost.closed_at).toBe(lost.updated_at)
  })

  it('a move between two won stages leaves closed_at unchanged (and likewise between two lost stages)', async () => {
    const w = await world()
    const won2 = await stage(w.p, 'Won - renewal', 'won', 95)
    const lost2 = await stage(w.p, 'Lost - later', 'lost', 105)
    const d = await deal(w.researched)
    const first = await move(d, w.won)
    const second = await move(d, won2)
    expect(second).toMatchObject({ stage_id: won2.id, status: 'won', closed_at: first.closed_at })
    expect(second.updated_at).not.toBe(first.updated_at)
    const l1 = await move(d, w.lost)
    expect(l1.closed_at).not.toBe(first.closed_at)
    expect((await move(d, lost2)).closed_at).toBe(l1.closed_at)
  })

  it('won -> open clears closed_at; open -> open leaves it null; a backwards move is allowed', async () => {
    const w = await world()
    const d = await deal(w.contacted)
    expect((await move(d, w.researched)).closed_at).toBeNull() // backwards, open to open
    await move(d, w.won)
    const reopened = await move(d, w.contacted)
    expect(reopened).toMatchObject({ stage_id: w.contacted.id, status: 'open', closed_at: null })
  })

  it('a deal created straight into a lost (or won) stage is closed at once', async () => {
    const w = await world()
    const lost = await deal(w.lost)
    expect(lost).toMatchObject({ status: 'lost', stage_id: w.lost.id })
    expect(lost.closed_at).toBe(lost.created_at)
    const won = await deal(w.won)
    expect(won).toMatchObject({ status: 'won', closed_at: won.created_at })
    expect((await deal(w.researched)).closed_at).toBeNull()
  })

  it('moving to the current stage is 200 with the record, no write, no updated_at change and no event', async () => {
    const w = await world()
    const d = await deal(w.won)
    const mark = (await e.rows('events')).length
    const rowBefore = (await e.rows('deals')).find((r) => r.id === d.id)
    const again = await move(d, w.won)
    expect(again).toEqual(d)
    expect(again.status).toBe('won')
    expect(await e.rows('events')).toHaveLength(mark)
    expect((await e.rows('deals')).find((r) => r.id === d.id)).toEqual(rowBefore)
  })

  it('a stage of another pipeline is 400 validation_error and changes nothing', async () => {
    const w = await world()
    const q = await pipeline('Other')
    const qs = await stage(q, 'Start', 'open', 1)
    const d = await deal(w.researched)
    const mark = (await e.rows('events')).length
    const err = await a.fail('deals.move_stage', { params: { id: d.id }, body: { stage_id: qs.id } })
    expect([err.status, err.code]).toEqual([400, 'validation_error'])
    expect(await a.call('deals.get', { params: { id: d.id } })).toEqual(d)
    expect(await e.rows('events')).toHaveLength(mark)
  })

  it('an unknown or deleted deal is 404; a body with another key or no stage_id is 400', async () => {
    const w = await world()
    expect((await a.fail('deals.move_stage', { params: { id: uuidv7() }, body: { stage_id: w.won.id } })).code).toBe('not_found')
    const d = await deal(w.researched)
    await a.call('deals.delete', { params: { id: d.id } })
    expect((await a.fail('deals.move_stage', { params: { id: d.id }, body: { stage_id: w.won.id } })).code).toBe('not_found')
    const d2 = await deal(w.researched)
    for (const body of [{}, { stage_id: 'x' }, { stage_id: w.won.id, closed_at: '2026-01-01T00:00:00.000Z' }]) {
      expect((await a.fail('deals.move_stage', { params: { id: d2.id }, body })).code).toBe('validation_error')
    }
  })

  it('a concurrent edit makes the move drift (409 conflict) like an update, and nothing is written', async () => {
    const w = await world()
    const d = await deal(w.researched)
    const mark = (await e.rows('events')).length
    e.betweenPlanAndCommit(async () => void (await a.call('deals.update', { params: { id: d.id }, body: { name: 'Edited meanwhile' } })))
    const err = await a.fail('deals.move_stage', { params: { id: d.id }, body: { stage_id: w.won.id } })
    expect([err.status, err.code]).toEqual([409, 'conflict'])
    expect(await a.call('deals.get', { params: { id: d.id } })).toMatchObject({ name: 'Edited meanwhile', stage_id: w.researched.id, closed_at: null })
    expect(await e.rows('events')).toHaveLength(mark + 1) // the concurrent update's own event only
  })

  it('deals.update never changes closed_at or the stage, on open and on closed deals', async () => {
    const w = await world()
    const d = await deal(w.researched)
    await move(d, w.won)
    const closed = await a.call('deals.get', { params: { id: d.id } })
    const renamed = await a.call('deals.update', { params: { id: d.id }, body: { name: 'Renamed', amount_minor: 10, currency: 'USD' } })
    expect(renamed).toMatchObject({ closed_at: closed.closed_at, stage_id: w.won.id, status: 'won', name: 'Renamed' })
  })
})

describe('events (D12)', () => {
  it('each write emits exactly one event with the actor, with the exact names', async () => {
    const p = await pipeline('Sales')
    const s = await stage(p, 'Won', 'won', 90, { as: 'agent' })
    const d = await deal(s)
    await a.call('pipelines.update', { params: { id: p.id }, body: { name: 'Sales 2' } })
    await a.call('pipeline_stages.update', { params: { id: s.id }, body: { position: 91 } })
    await a.call('deals.update', { params: { id: d.id }, body: { name: 'Renamed' } }, { as: 'agent' })
    await a.call('deals.delete', { params: { id: d.id } })
    await a.call('pipeline_stages.delete', { params: { id: s.id } })
    await a.call('pipelines.delete', { params: { id: p.id } })
    const evs = (await e.rows('events')).sort((x, y) => String(x.id).localeCompare(String(y.id)))
    expect(evs.map((x) => [x.type, x.actor_id])).toEqual([
      ['pipeline.created', e.userId],
      ['pipeline_stage.created', e.agentId],
      ['deal.created', e.userId],
      ['pipeline.updated', e.userId],
      ['pipeline_stage.updated', e.userId],
      ['deal.updated', e.agentId],
      ['deal.deleted', e.userId],
      ['pipeline_stage.deleted', e.userId],
      ['pipeline.deleted', e.userId],
    ])
    expect(evs.map((x) => x.resource_type)).toEqual(['pipeline', 'pipeline_stage', 'deal', 'pipeline', 'pipeline_stage', 'deal', 'deal', 'pipeline_stage', 'pipeline'])
    expect(evs[0]!.after).toMatchObject({ id: p.id, name: 'Sales' })
    expect(evs[8]!.after).toBeNull()
    expect(evs[8]!.before).toMatchObject({ id: p.id, name: 'Sales 2' })
  })

  it('a move emits only deal.stage_changed, whose before/after show stage_id and closed_at; an edit of other fields only deal.updated', async () => {
    const w = await world()
    const d = await deal(w.researched)
    const base = (await e.rows('events')).length
    const moved = await move(d, w.won)
    await a.call('deals.update', { params: { id: d.id }, body: { name: 'Renamed' } })
    const fresh = (await e.rows('events')).slice(base)
    expect(fresh.map((x) => x.type)).toEqual(['deal.stage_changed', 'deal.updated'])
    const [changed, updated] = fresh
    expect(changed).toMatchObject({ resource_type: 'deal', resource_id: d.id, actor_id: e.userId })
    expect(changed!.before).toMatchObject({ stage_id: w.researched.id, closed_at: null })
    expect(changed!.after).toMatchObject({ stage_id: w.won.id, closed_at: moved.closed_at })
    expect(updated!.before).toMatchObject({ stage_id: w.won.id, name: 'Acme - pilot' })
    expect(updated!.after).toMatchObject({ stage_id: w.won.id, name: 'Renamed', closed_at: moved.closed_at })
  })

  it('a pipeline delete emits one pipeline_stage.deleted per stage, then pipeline.deleted', async () => {
    const w = await world()
    const base = (await e.rows('events')).length
    await a.call('pipelines.delete', { params: { id: w.p.id } })
    const fresh = (await e.rows('events')).slice(base).sort((x, y) => String(x.id).localeCompare(String(y.id)))
    expect(fresh.map((x) => x.type)).toEqual(['pipeline_stage.deleted', 'pipeline_stage.deleted', 'pipeline_stage.deleted', 'pipeline_stage.deleted', 'pipeline.deleted'])
    expect(fresh.slice(0, 4).map((x) => x.resource_id).sort()).toEqual([w.researched.id, w.contacted.id, w.won.id, w.lost.id].sort())
    expect(fresh[4]!.resource_id).toBe(w.p.id)
    expect(fresh.every((x) => x.actor_id === e.userId)).toBe(true)
  })
})

describe('status is derived and never in events (D8)', () => {
  const noStatus = (r: Rec | null) => {
    if (r !== null) expect(Object.keys(r)).not.toContain('status')
  }

  it('status follows the stage kind on get and list after each move', async () => {
    const w = await world()
    const d = await deal(w.researched)
    const statusOf = async () => [(await a.call('deals.get', { params: { id: d.id } })).status, (await a.call('deals.list', { query: {} })).data[0].status]
    expect(await statusOf()).toEqual(['open', 'open'])
    await move(d, w.won)
    expect(await statusOf()).toEqual(['won', 'won'])
    await move(d, w.lost)
    expect(await statusOf()).toEqual(['lost', 'lost'])
    await move(d, w.contacted)
    expect(await statusOf()).toEqual(['open', 'open'])
  })

  it('status is absent from before and after of every deal.* event: create, update, move_stage, delete (as an actor holding deals:read)', async () => {
    const w = await world()
    const d = await deal(w.researched)
    expect(d.status).toBe('open') // the actor sees it on reads
    const moved = await move(d, w.won)
    expect(moved.status).toBe('won')
    await a.call('deals.update', { params: { id: d.id }, body: { name: 'Renamed' } })
    await a.call('deals.delete', { params: { id: d.id } })
    const evs = await events('deal.')
    expect(evs.map((x) => x.type)).toEqual(['deal.created', 'deal.stage_changed', 'deal.updated', 'deal.deleted'])
    for (const ev of evs) {
      noStatus(ev.before)
      noStatus(ev.after)
    }
    expect(evs[1]!.before).toMatchObject({ stage_id: w.researched.id })
  })

  it('the no-op move answers with status but writes no event', async () => {
    const w = await world()
    const d = await deal(w.contacted)
    expect((await move(d, w.contacted)).status).toBe('open')
    expect((await events('deal.')).map((x) => x.type)).toEqual(['deal.created'])
  })

  it('the status filter returns exactly the open, won and lost deals; an unknown value is 400', async () => {
    const w = await world()
    const o1 = await deal(w.researched, { name: 'o1' })
    const o2 = await deal(w.contacted, { name: 'o2' })
    const w1 = await deal(w.won, { name: 'w1' })
    const l1 = await deal(w.lost, { name: 'l1' })
    const moved = await deal(w.researched, { name: 'moved' })
    await move(moved, w.lost)
    const by = async (status: string) => ids(await a.call('deals.list', { query: { status } }))
    expect(await by('open')).toEqual([o1.id, o2.id].sort())
    expect(await by('won')).toEqual([w1.id])
    expect(await by('lost')).toEqual([l1.id, moved.id].sort())
    for (const bad of ['closed', 'OPEN', '']) expect((await a.fail('deals.list', { query: { status: bad } })).code, bad).toBe('validation_error')
  })
})

describe('delete holds (D13)', () => {
  it('a stage holding one live closed deal is 409 stage_in_use; with the deal deleted the stage deletes (empty state)', async () => {
    const w = await world()
    const d = await deal(w.won)
    const mark = (await e.rows('events')).length
    const err = await a.fail('pipeline_stages.delete', { params: { id: w.won.id } })
    expect([err.status, err.code]).toEqual([409, 'stage_in_use'])
    expect(err.message).toContain('1')
    expect(err.message).toContain(d.id)
    expect(await e.rows('events')).toHaveLength(mark)
    expect((await live('pipeline_stages')).map((r) => r.id)).toContain(w.won.id)
    await a.call('deals.delete', { params: { id: d.id } })
    await a.call('pipeline_stages.delete', { params: { id: w.won.id } })
    expect((await live('pipeline_stages')).map((r) => r.id)).not.toContain(w.won.id)
  })

  it('the stage_in_use message gives the count and at most five ids (six deals seeded)', async () => {
    const w = await world()
    const made: string[] = []
    for (let i = 0; i < 6; i++) made.push((await deal(w.contacted, { name: `D${i}` })).id)
    const err = await a.fail('pipeline_stages.delete', { params: { id: w.contacted.id } })
    expect([err.status, err.code]).toEqual([409, 'stage_in_use'])
    expect(err.message).toMatch(/\b6\b/)
    const named = err.message.match(UUID) ?? []
    expect(named).toHaveLength(5)
    expect(named.every((x) => made.includes(x))).toBe(true)
    expect(named).toEqual([...named].sort()) // the first five in id order
    expect(new Set(named).size).toBe(5)
  })

  it('a stage holding only deleted deals can be deleted; other stages are not held by it', async () => {
    const w = await world()
    const d = await deal(w.contacted)
    await a.call('deals.delete', { params: { id: d.id } })
    await a.call('pipeline_stages.delete', { params: { id: w.contacted.id } })
    expect((await live('pipeline_stages')).map((r) => r.name).sort()).toEqual(['Lost', 'Researched', 'Won'])
    await deal(w.researched)
    await a.call('pipeline_stages.delete', { params: { id: w.lost.id } }) // another stage of the same pipeline
  })

  it('a pipeline with a live deal is 409 pipeline_in_use (count and ids); with the deal deleted the pipeline deletes with its stages', async () => {
    const w = await world()
    const d = await deal(w.lost)
    const mark = (await e.rows('events')).length
    const err = await a.fail('pipelines.delete', { params: { id: w.p.id } })
    expect([err.status, err.code]).toEqual([409, 'pipeline_in_use'])
    expect(err.message).toContain(d.id)
    expect(await e.rows('events')).toHaveLength(mark)
    expect(await live('pipeline_stages')).toHaveLength(4)
    await a.call('deals.delete', { params: { id: d.id } })
    await a.call('pipelines.delete', { params: { id: w.p.id } })
    expect(await live('pipelines')).toEqual([])
  })

  it('the pipeline_in_use message also names at most five ids', async () => {
    const w = await world()
    for (let i = 0; i < 6; i++) await deal(i % 2 ? w.researched : w.contacted, { name: `D${i}` })
    const err = await a.fail('pipelines.delete', { params: { id: w.p.id } })
    expect(err.code).toBe('pipeline_in_use')
    expect(err.message).toMatch(/\b6\b/)
    expect(err.message.match(UUID) ?? []).toHaveLength(5)
  })

  it('a pipeline with N stages soft-deletes all of them: deleted_at set, rows kept; another pipeline is untouched', async () => {
    const w = await world()
    const q = await pipeline('Keep')
    const qs = await stage(q, 'Keep stage', 'open', 1)
    await a.call('pipelines.delete', { params: { id: w.p.id } })
    const stages = (await e.rows('pipeline_stages')).filter((r) => r.pipeline_id === w.p.id)
    expect(stages).toHaveLength(4)
    expect(stages.every((r) => typeof r.deleted_at === 'string')).toBe(true)
    expect((await e.rows('pipelines')).find((r) => r.id === w.p.id)!.deleted_at).toEqual(expect.any(String))
    expect((await live('pipeline_stages')).map((r) => r.id)).toEqual([qs.id])
    expect((await live('pipelines')).map((r) => r.id)).toEqual([q.id])
    expect((await a.fail('pipeline_stages.get', { params: { id: w.won.id } })).code).toBe('not_found')
  })

  it('a deal created into the stage between plan and commit aborts the stage delete: no deleted stage with a live deal', async () => {
    const w = await world()
    const mark = (await e.rows('events')).length
    e.betweenPlanAndCommit(async () => void (await deal(w.contacted, { name: 'Raced in' })))
    const err = await a.fail('pipeline_stages.delete', { params: { id: w.contacted.id } })
    expect(err.status).toBe(409)
    expect((await live('pipeline_stages')).map((r) => r.id)).toContain(w.contacted.id)
    expect(await live('deals')).toHaveLength(1)
    expect((await e.rows('events')).slice(mark).map((x) => x.type)).toEqual(['deal.created']) // no pipeline_stage.deleted
  })

  it('a deal created into the pipeline between plan and commit aborts the pipeline delete', async () => {
    const w = await world()
    const mark = (await e.rows('events')).length
    e.betweenPlanAndCommit(async () => void (await deal(w.researched, { name: 'Raced in' })))
    const err = await a.fail('pipelines.delete', { params: { id: w.p.id } })
    expect(err.status).toBe(409)
    expect((await live('pipelines')).map((r) => r.id)).toEqual([w.p.id])
    expect(await live('pipeline_stages')).toHaveLength(4)
    expect(await live('deals')).toHaveLength(1)
    expect((await e.rows('events')).slice(mark).map((x) => x.type)).toEqual(['deal.created'])
  })

  it('a stage created into the pipeline between plan and commit aborts the cascade', async () => {
    const w = await world()
    const mark = (await e.rows('events')).length
    e.betweenPlanAndCommit(async () => void (await stage(w.p, 'Raced stage', 'open', 55)))
    const err = await a.fail('pipelines.delete', { params: { id: w.p.id } })
    expect(err.status).toBe(409)
    expect((await live('pipelines')).map((r) => r.id)).toEqual([w.p.id])
    expect(await live('pipeline_stages')).toHaveLength(5)
    expect((await e.rows('events')).slice(mark).map((x) => x.type)).toEqual(['pipeline_stage.created'])
  })

  it('deals.delete soft-deletes the deal with one deal.deleted event; its status is then not found', async () => {
    const w = await world()
    const d = await deal(w.researched)
    await a.call('deals.delete', { params: { id: d.id } })
    expect((await e.rows('deals'))[0]!.deleted_at).toEqual(expect.any(String))
    expect((await a.fail('deals.get', { params: { id: d.id } })).code).toBe('not_found')
    expect((await events('deal.')).map((x) => x.type)).toEqual(['deal.created', 'deal.deleted'])
  })
})

describe('the set limit on a pipeline delete (D13)', () => {
  it('over the limit is 400 set_limit_exceeded and nothing changes', async () => {
    const limited = await openD1Engine({ maxSetSize: 3 })
    try {
      const k = assocKit(limited)
      const p = await k.call('pipelines.create', { body: { name: 'Big' } })
      for (let i = 0; i < 4; i++) await k.call('pipeline_stages.create', { body: { pipeline_id: p.id, name: `S${i}`, kind: 'open', position: i } })
      const mark = (await limited.rows('events')).length
      const err = await k.fail('pipelines.delete', { params: { id: p.id } })
      expect([err.status, err.code]).toEqual([400, 'set_limit_exceeded'])
      expect((await limited.rows('pipelines'))[0]!.deleted_at).toBeNull()
      expect((await limited.rows('pipeline_stages')).every((r) => r.deleted_at === null)).toBe(true)
      expect(await limited.rows('events')).toHaveLength(mark)
    } finally {
      await limited.close()
    }
  })
})

describe('list filters (D15 column part)', () => {
  it('deals.list filters pipeline_id, stage_id, owner_id, created_by and status, ANDed, paging across a page boundary', async () => {
    const w = await world()
    const q = await pipeline('Other')
    const qs = await stage(q, 'Start', 'open', 1)
    const mine = [] as Rec[]
    for (let i = 0; i < 5; i++) mine.push(await deal(w.researched, { name: `M${i}`, owner_id: e.userId }))
    const wonOne = await deal(w.won, { name: 'won', owner_id: e.userId })
    const agents = await deal(w.researched, { name: 'agent', owner_id: e.agentId }, { as: 'agent' })
    const elsewhere = await deal(qs, { name: 'elsewhere', owner_id: e.userId })
    const all = async (query: Rec) => {
      const out: string[] = []
      let after: string | null = null
      let pages = 0
      do {
        const page: { data: Rec[]; next_cursor: string | null } = await a.call('deals.list', { query: { ...query, limit: 2, ...(after ? { after } : {}) } })
        out.push(...page.data.map((r) => r.id as string))
        after = page.next_cursor
        pages++
      } while (after)
      return { out, pages }
    }
    expect((await all({ stage_id: w.researched.id })).out.sort()).toEqual([...mine.map((r) => r.id), agents.id].sort())
    const owned = await all({ stage_id: w.researched.id, owner_id: e.userId })
    expect(owned.out).toEqual(mine.map((r) => r.id)) // five matches over pages of two
    expect(owned.pages).toBe(3)
    expect((await all({ pipeline_id: q.id })).out).toEqual([elsewhere.id])
    expect((await all({ pipeline_id: w.p.id, created_by: e.agentId })).out).toEqual([agents.id])
    expect((await all({ pipeline_id: w.p.id, status: 'won' })).out).toEqual([wonOne.id])
    expect((await all({ pipeline_id: w.p.id, owner_id: e.userId, status: 'open' })).out).toEqual(mine.map((r) => r.id))
    expect((await all({ status: 'open', stage_id: w.won.id })).out).toEqual([]) // ANDed: no open deal in a won stage
    expect((await all({})).out).toHaveLength(8)
  })

  it('an id matching nothing is an empty page, not an error', async () => {
    const w = await world()
    await deal(w.researched)
    for (const query of [{ pipeline_id: uuidv7() }, { stage_id: uuidv7() }, { owner_id: uuidv7() }, { created_by: uuidv7() }]) {
      expect(await a.call('deals.list', { query })).toEqual({ data: [], next_cursor: null })
    }
    expect((await a.fail('deals.list', { query: { stage_id: 'nope' } })).code).toBe('validation_error')
    expect((await a.fail('deals.list', { query: { company_id: uuidv7() } })).code).toBe('validation_error') // the join filters are CORE136
  })

  it('pipelines.list filters name case-insensitively; pipeline_stages.list filters pipeline_id and kind', async () => {
    const w = await world()
    const q = await pipeline('Renewals')
    const qs = await stage(q, 'Won', 'won', 1)
    expect(ids(await a.call('pipelines.list', { query: { name: 'sales' } }))).toEqual([w.p.id])
    expect(ids(await a.call('pipelines.list', { query: { name: 'RENEWALS' } }))).toEqual([q.id])
    expect(ids(await a.call('pipelines.list', { query: { name: 'nothing' } }))).toEqual([])
    expect(ids(await a.call('pipelines.list', { query: {} }))).toEqual([w.p.id, q.id].sort())
    expect(ids(await a.call('pipeline_stages.list', { query: { pipeline_id: w.p.id } }))).toEqual([w.researched.id, w.contacted.id, w.won.id, w.lost.id].sort())
    expect(ids(await a.call('pipeline_stages.list', { query: { kind: 'won' } }))).toEqual([w.won.id, qs.id].sort())
    expect(ids(await a.call('pipeline_stages.list', { query: { pipeline_id: q.id, kind: 'lost' } }))).toEqual([])
    expect(ids(await a.call('pipeline_stages.list', { query: { pipeline_id: uuidv7() } }))).toEqual([])
    expect((await a.fail('pipeline_stages.list', { query: { kind: 'closed' } })).code).toBe('validation_error')
  })
})
