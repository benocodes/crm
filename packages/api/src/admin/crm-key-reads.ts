import { defineOperation, readMaybe, unit, type PreparedOperation } from '@vibase/storage'

// [[CORE351]] P1: the CRM fact a key create needs now that keys live in the control plane: the agent it names. A read-only program run through `ControlEnv.read`; nothing here writes.

/** The agent of the organisation, or `false` (a disabled agent exists: [[CORE27]]). */
export function readAgentExists(organizationId: string, agentId: string): PreparedOperation<boolean> {
  return defineOperation({
    name: 'api_keys.read_agent',
    mutates: false,
    reads: (qc) => ({
      agent: readMaybe(
        qc.db
          .selectFrom('agents')
          .select('agents.id')
          .where('agents.id', '=', agentId)
          .where('agents.organization_id', '=', organizationId),
      ),
    }),
    build: (found) => unit({ steps: [], events: [], decode: () => found.maybe('agent') !== null }),
  })
}
