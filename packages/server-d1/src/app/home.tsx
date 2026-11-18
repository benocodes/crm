// [[UI460]] D10 (part), P5 ([[UI443]]): Home. "Welcome to your CRM" and Who you are: the person's name, email, role and the active workspace's name. No Get started section and no list reads yet (UI461, UI458).
import { SettingsPage, SettingsRow, SettingsSection } from '@vibase/ui/components'
import type { Who } from './state.js'

export function HomePage({ who, error }: { who: Who; error?: string }) {
  return (
    <SettingsPage title="Welcome to your CRM" {...(error ? { error } : {})}>
      <SettingsSection title="Who you are" readOnly>
        <SettingsRow label="Name">{who.name}</SettingsRow>
        <SettingsRow label="Email">{who.email}</SettingsRow>
        <SettingsRow label="Role">{who.role}</SettingsRow>
        <SettingsRow label="Workspace">{who.workspaceName}</SettingsRow>
      </SettingsSection>
    </SettingsPage>
  )
}
