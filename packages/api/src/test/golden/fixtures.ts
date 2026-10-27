// The golden fixture list and the engine differences a fixture names ([[CORE35]] D17, [[CORE36]] D12, D22). Open test data:
// the replays in @vault/api and the Postgres-side generator in @vault/server-postgres both read it from here.
import { administrationScenarios, authScenarios, directoryScenarios, identityModelScenarios, taskScenarios } from './scenarios.js'

/**
 * The engine differences a fixture names: D1 fixed-organisation admission ([[CORE36]] D19, [[CORE41]] P13) is the only one.
 * A fixture lists the entries whose scenario it holds, and the D1 replay asserts the D1 outcome for that scenario instead of
 * equality with the Postgres transcript.
 */
export const NAMED_DIFFERENCES: Array<{ engine: string; scenario: string; what: string; why: string }> = [
  {
    engine: 'd1',
    scenario: 'foreign-organisation-claim',
    what: 'a token claiming another organisation is refused 403 before any SQL',
    why: 'CORE36 D19: one organisation per D1',
  },
]

export const FIXTURES = [
  { file: 'tasks.json', resource: 'tasks', scenarios: taskScenarios },
  { file: 'identity-model.json', resource: 'identity-model', scenarios: identityModelScenarios },
  { file: 'administration.json', resource: 'administration', scenarios: administrationScenarios },
  { file: 'auth.json', resource: 'auth', scenarios: authScenarios },
  { file: 'directory.json', resource: 'directory', scenarios: directoryScenarios },
] as const
