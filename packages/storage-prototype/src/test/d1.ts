import { uuid7 } from '../uuid7.js'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import type { ExecutionContext } from '../types.js'
import { ScopeSet } from '@vault/api'
export async function d1Fixture() {
  const id = uuid7
  const a = {
    organizationId: id(),
    actor: { id: id(), kind: 'user' as const },
    scopes: ScopeSet.parse(['tasks:write', 'contacts:write']),
  }
  const b = { organizationId: id(), actor: { id: id(), kind: 'user' as const }, scopes: a.scopes }
  const agentContext = { ...a, actor: { id: id(), kind: 'agent' as const } }
  const mf = new Miniflare({
    modules: true,
    scriptPath: new URL('./batch-worker.mjs', import.meta.url).pathname,
    compatibilityDate: '2026-07-30',
    d1Persist: false,
    d1Databases: { DB_A: id(), DB_B: id() },
    bindings: { ORG_A: a.organizationId, ORG_B: b.organizationId },
  })
  try {
    const da = await mf.getD1Database('DB_A'),
      db = await mf.getD1Database('DB_B')
    for (const [binding, ctx] of [
      [da, a],
      [db, b],
    ] as const) {
      const statements = readFileSync(new URL('../fixtures/d1.sql', import.meta.url), 'utf8')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      await binding.batch(statements.map((s) => binding.prepare(s)))
      await binding.prepare('INSERT INTO deployment VALUES(1,?)').bind(ctx.organizationId).run()
      await binding.prepare('INSERT INTO principals VALUES(?,?)').bind(ctx.actor.id, 'user').run()
    }
    await da.prepare('INSERT INTO principals VALUES(?,?)').bind(agentContext.actor.id, 'agent').run()
    const query = async (text: string, parameters: unknown[] = [], side = 'a') => {
      const binding = side === 'a' ? da : db
      return (
        await (parameters.length ? binding.prepare(text).bind(...parameters) : binding.prepare(text)).all()
      ).results as any[]
    }
    const seed = async (
      ctx: ExecutionContext = a,
      resource: 'tasks' | 'contacts' | 'identities' = 'tasks',
      input: any = { title: 'Old' },
    ) => {
      const common = {
        id: id(),
        organization_id: ctx.organizationId,
        created_by: ctx.actor.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      }
      const row =
        resource === 'tasks'
          ? {
              ...common,
              title: 'Old',
              notes: null,
              status: 'open',
              due_at: null,
              completed_at: null,
              assignee_id: null,
              ...input,
            }
          : resource === 'contacts'
            ? { ...common, name: null, company_id: null, merged_into_id: null, ...input }
            : { ...common, contact_id: null, own: 1, ...input }
      const keys = Object.keys(row)
      await query(
        `INSERT INTO ${resource} (${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
        Object.values(row),
        ctx.organizationId === a.organizationId ? 'a' : 'b',
      )
      const { deleted_at, ...publicRow } = row
      return resource === 'identities' ? { ...publicRow, own: !!(publicRow as any).own } : publicRow
    }
    return {
      mf,
      da,
      db,
      a,
      b,
      agentContext,
      seed,
      query,
      clearEvents: async () => {
        await query('DELETE FROM events')
      },
      close: () => mf.dispose(),
    }
  } catch (e) {
    await mf.dispose()
    throw e
  }
}
