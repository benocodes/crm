// Test-only. Runs golden scenarios ([[CORE35]] D17) against any backend and turns them into transcripts.
import type { GoldenActor, GoldenScenario, GoldenStep } from './scenarios.js'

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

/** Stable JSON text of a fixture file: two-space indent, trailing newline. */
export const fixtureText = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'
