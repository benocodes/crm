// Test-only. Runs golden scenarios ([[CORE35]] D17) against any backend and turns them into transcripts.
import { FIXED_IDS, type GoldenActor, type GoldenScenario, type GoldenStep } from './scenarios.js'

export interface EventView {
  type: string
  resource_type: string
  resource_id: string
  actor_id: string
  organization_id: string
  created_at: string
  before: unknown
  after: unknown
}
export interface GoldenBackend {
  /** Empties the store, seeds the fixed principals and restarts the injected id source. */
  reset(): Promise<void>
  /** One request as `actor`; the backend injects `clock` into the unit it runs. */
  send(actor: GoldenActor, method: string, path: string, body: unknown, clock: string): Promise<{ status: number; body: unknown }>
  /** Every event in write order. */
  events(): Promise<EventView[]>
}
export interface TranscriptStep {
  as: GoldenActor
  at: string
  method: string
  path: string
  request: unknown
  status: number
  response: unknown
  events: EventView[]
}
export interface Transcript {
  name: string
  about: string
  steps: TranscriptStep[]
}

const fill = (template: string, saved: Map<string, string>): string =>
  template.replaceAll(/\{(\w+)\}/g, (_m, name: string) => {
    const id = saved.get(name)
    if (!id) throw new Error(`scenario references unsaved "${name}"`)
    return id
  })
const fillDeep = (value: unknown, saved: Map<string, string>): unknown => {
  if (typeof value === 'string') return /^\{\w+\}$/.test(value) ? fill(value, saved) : value
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, saved))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, saved)]))
  return value
}

export async function runScenario(backend: GoldenBackend, scenario: GoldenScenario): Promise<Transcript> {
  await backend.reset()
  const saved = new Map<string, string>()
  const steps: TranscriptStep[] = []
  let seen = 0
  for (const step of scenario.steps as readonly GoldenStep[]) {
    const path = fill(step.path, saved)
    const body = fillDeep(step.body, saved)
    const res = await backend.send(step.as, step.method, path, body, step.at)
    if (step.save && res.status < 300) saved.set(step.save, (res.body as { id: string }).id)
    const events = await backend.events()
    steps.push({
      as: step.as,
      at: step.at,
      method: step.method,
      path: step.path,
      request: step.body ?? null,
      status: res.status,
      response: res.body,
      events: events.slice(seen),
    })
    seen = events.length
  }
  return { name: scenario.name, about: scenario.about, steps }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SERVER_TIME = new Set(['created_at', 'updated_at', 'completed_at', 'deleted_at'])

/**
 * The legacy oracle's comparison form: ids the service generated become `<id:n>` by first appearance and
 * server-stamped timestamps become `<ts>` (null stays null). Seed ids and client-supplied values stay exact.
 * Used only to compare against the transcript recorded from the pre-migration service, whose ids and clock
 * cannot be injected; the exact fixtures never go through it.
 */
export function symbolic<T>(value: T): T {
  const names = new Map<string, string>()
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key && SERVER_TIME.has(key)) return '<ts>'
      if (UUID.test(v) && !FIXED_IDS.has(v)) {
        if (!names.has(v)) names.set(v, `<id:${names.size + 1}>`)
        return names.get(v)
      }
      return v.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => {
        if (FIXED_IDS.has(m)) return m
        if (!names.has(m)) names.set(m, `<id:${names.size + 1}>`)
        return names.get(m)!
      })
    }
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  return walk(value) as T
}

/** Stable JSON text of a fixture file: two-space indent, trailing newline. */
export const fixtureText = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'
