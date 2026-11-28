import { defineOperation, readMaybe, unit, type PreparedOperation } from '@vibase/storage'

// [[AGT701]] D13: the CRM facts an agent invitation needs now that invitations live in the control plane: the agent it names, in the organisation. A read-only program run through `ControlEnv.read`
// (the pattern of `admin/crm-key-reads.ts`); nothing here writes.

/** What `invitations.create` decides from: a form's principal (live or deleted form row), a delegated agent (`delegated_by` set), a disabled agent, an agent that already has a sign-in account (`auth_subject` set). */
export interface AgentForInvitation {
  formId: string | null
  delegated: boolean
  disabled: boolean
  hasAccount: boolean
}

/** The agent of the organisation, or `null` when there is none (an unknown id, or another organisation's). */
export function readAgentForInvitation(
  organizationId: string,
  agentId: string,
): PreparedOperation<AgentForInvitation | null> {
  return defineOperation({
    name: 'invitations.read_agent',
    mutates: false,
    reads: (qc) => ({
      agent: readMaybe(
        qc.db
          .selectFrom('agents')
          .select(['agents.id', 'agents.delegated_by', 'agents.disabled_at', 'agents.auth_subject'])
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
          return {
            formId: form ? String(form.id) : null,
            delegated: agent.delegated_by != null,
            disabled: agent.disabled_at != null,
            hasAccount: agent.auth_subject != null,
          }
        },
      }),
  })
}
