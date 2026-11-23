// [[UI460]] D10 (part), P5, [[UI461]] D9, D10 ([[UI443]]): Home. "Welcome to your CRM", Get started (the Connect your email prompt while the person owns no mailbox and the Connect an agent prompt while no enabled agent is known, each or its one-line error), then Who you are: the person's name, email, role and the active workspace's name.
// An owner and a member see the same Home.
import { Alert, PromptCard, SettingsPage, SettingsRow, SettingsSection } from '@vibase/ui/components'
import { ConnectAgentInstructions, type ConnectAgentInstructionsProps } from './connect-agent.js'
import { type ConnectAgentCheck, type ConnectEmailCheck, getStarted } from './first-steps.js'
import type { Who } from './state.js'

export interface HomeProps {
  who: Who
  error?: string
  connectEmail: ConnectEmailCheck
  connectAgent: ConnectAgentCheck
  instructions: ConnectAgentInstructionsProps
  onCheckAgain(): void
}

export function HomePage({ who, error, connectEmail, connectAgent, instructions, onCheckAgain }: HomeProps) {
  const first = getStarted(connectEmail, connectAgent)
  return (
    <SettingsPage title="Welcome to your CRM" {...(error ? { error } : {})}>
      {first ? (
        <SettingsSection title="Get started">
          <div className="flex flex-col gap-4">
            {first.emailError ? <Alert variant="error">{first.emailError}</Alert> : null}
            {first.emailPrompt ? (
              <PromptCard
                title="Connect your email"
                text="Connect your Gmail so your conversations land in your CRM."
                action={{ label: 'Connect Gmail', href: '/app/accounts' }}
              />
            ) : null}
            {first.agentError ? <Alert variant="error">{first.agentError}</Alert> : null}
            {first.agentPrompt ? (
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
