// [[UI460]] D10 (part), P5, [[UI461]] D9, D10 ([[UI443]]): Home. "Welcome to your CRM", Get started (the Connect an agent prompt while no enabled agent is known, or its one-line error), then Who you are: the person's name, email, role and the active workspace's name.
// An owner and a member see the same Home.
import { Alert, PromptCard, SettingsPage, SettingsRow, SettingsSection } from '@vibase/ui/components'
import { ConnectAgentInstructions, type ConnectAgentInstructionsProps } from './connect-agent.js'
import { type ConnectAgentCheck, getStarted } from './first-steps.js'
import type { Who } from './state.js'

export interface HomeProps {
  who: Who
  error?: string
  connectAgent: ConnectAgentCheck
  instructions: ConnectAgentInstructionsProps
  onCheckAgain(): void
}

export function HomePage({ who, error, connectAgent, instructions, onCheckAgain }: HomeProps) {
  const first = getStarted(connectAgent)
  return (
    <SettingsPage title="Welcome to your CRM" {...(error ? { error } : {})}>
      {first ? (
        <SettingsSection title="Get started">
          <div className="flex flex-col gap-4">
            {first.error ? <Alert variant="error">{first.error}</Alert> : null}
            {first.prompt ? (
              <PromptCard
                title="Connect an agent"
                text="No agent is connected to this workspace yet. Connect one to let it read and work with your data."
                action={{ label: 'Check again', onClick: onCheckAgain }}
              >
                <ConnectAgentInstructions {...instructions} />
              </PromptCard>
            ) : null}
          </div>
        </SettingsSection>
      ) : null}
      <SettingsSection title="Who you are" readOnly>
        <SettingsRow label="Name">{who.name}</SettingsRow>
        <SettingsRow label="Email">{who.email}</SettingsRow>
        <SettingsRow label="Role">{who.role}</SettingsRow>
        <SettingsRow label="Workspace">{who.workspaceName}</SettingsRow>
      </SettingsSection>
    </SettingsPage>
  )
}
