import { defineOperation, readMaybe, unit, type PreparedOperation } from '@vibase/storage'

// [[CORE351]] P1: the CRM fact a key create needs now that keys live in the control plane: the agent it names. A read-only program run through `ControlEnv.read`; nothing here writes.

/**
 * The agent of the organisation, or `null` (a disabled agent exists: [[CORE27]]). `formId` is the id of the `forms` row the agent is the principal of, live or soft-deleted, else `null`:
 * a key for a form's principal is refused ([[CHN423]] D4, P2), decided from this one read before any control write. `delegated` is whether the agent acts for a member (`delegated_by` set; [[CORE573]] D13): such an agent is refused a key the same way.
 */
export function readAgentForKey(
  organizationId: string,
  agentId: string,
): PreparedOperation<{ formId: string | null; delegated: boolean } | null> {
  return defineOperation({
    name: 'api_keys.read_agent',
    mutates: false,
    reads: (qc) => ({
      agent: readMaybe(
        qc.db
          .selectFrom('agents')
          .select(['agents.id', 'agents.delegated_by'])
          .where('agents.id', '=', agentId)
          .where('agents.organization_id', '=', organizationId),
      ),
      form: readMaybe(
        qc.db
          .selectFrom('forms')
          .select('forms.id')
          .where('forms.id', '=', agentId)
          .where('forms.organization_id', '=', organizationId),
      ),
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const agent = found.maybe('agent')
          if (agent === null) return null
          const form = found.maybe('form')
          return { formId: form ? String(form.id) : null, delegated: agent.delegated_by != null }
        },
      }),
  })
}
