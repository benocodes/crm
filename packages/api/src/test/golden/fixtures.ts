// The golden fixture list and the engine differences a fixture names ([[CORE35]] D17, [[CORE36]] D12, D22). Open test data:
// the replays (D1 and Postgres) and the D1 generator (packages/api/scripts/golden.ts, [[CORE72]]) all read it from here.
import { administrationScenarios, authScenarios, directoryScenarios, identityModelScenarios, messagingScenarios, taskScenarios } from './scenarios.js'

/**
 * The engine differences a fixture names ([[CORE72]], [[CORE69]] D20). D1 is the oracle that generates every fixture and its replay
 * asserts equality on every scenario; what is named here is where the parked Postgres engine differs. The only one: Postgres is
 * multi-tenant, so a token claiming another provider organisation is admitted and repaired there, where a D1 serves one organisation
 * and refuses it 403 before any SQL ([[CORE36]] D19, [[CORE41]] P13). The Postgres replay asserts its own outcome for that scenario
 * instead of equality.
 */
export const NAMED_DIFFERENCES: Array<{ engine: string; scenario: string; what: string; why: string }> = [
  {
    engine: 'postgres',
    scenario: 'foreign-organisation-claim',
    what: 'a token claiming another provider organisation is admitted (200) and its organisation and membership are created',
    why: 'Postgres is multi-tenant: the organisation is repaired from the claim; a D1 serves one organisation (CORE36 D19)',
  },
]

export const FIXTURES = [
  { file: 'tasks.json', resource: 'tasks', scenarios: taskScenarios },
  { file: 'identity-model.json', resource: 'identity-model', scenarios: identityModelScenarios },
  { file: 'administration.json', resource: 'administration', scenarios: administrationScenarios },
  { file: 'auth.json', resource: 'auth', scenarios: authScenarios },
  { file: 'directory.json', resource: 'directory', scenarios: directoryScenarios },
  { file: 'messaging.json', resource: 'messaging', scenarios: messagingScenarios },
] as const
