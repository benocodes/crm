// The composites page of the React gallery ([[UI443]] cycle 1, D11): AppShell, SettingsPage, SettingsSection, SettingsRow, PromptCard and
// CommandBlock in every state. Page code: only this page's layout is styled here; the composites carry their own classes.
import { Home, KeyRound, Users } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import {
  AppShell,
  Button,
  CommandBlock,
  PromptCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  ui,
} from '../../src/components'

const NAV = [
  { label: 'Home', href: '/home', icon: Home, current: true },
  { label: 'Accounts', href: '/accounts', icon: KeyRound },
  { label: 'Agents', href: '/agents', icon: Users },
]
const ATTACK = '<b>x</b> & "q"'

function State({ state, title, children }: { state: string; title: string; children: ReactNode }) {
  return (
    <section data-gallery-state={state} aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

function PageError() {
  const [error, setError] = useState<string | undefined>(undefined)
  return (
    <State state="page-error" title="SettingsPage, with an error">
      <SettingsPage
        title="Agents"
        error={error}
        actions={<Button onClick={() => setError('Could not load agents.')}>Raise a page error</Button>}
      >
        <p className="text-sm">Content.</p>
      </SettingsPage>
    </State>
  )
}

function Sections() {
  return (
    <>
      <State state="sections" title="SettingsSection and SettingsRow">
        <SettingsSection title="Who you are" description="Your account in this workspace." readOnly>
          <SettingsRow label="Name">Ada Lovelace</SettingsRow>
          <SettingsRow label="Email">ada@example.com</SettingsRow>
          <SettingsRow label="Role" description="Set by the workspace owner.">
            Owner
          </SettingsRow>
        </SettingsSection>
        <SettingsSection title="Profile">
          <SettingsRow label="Display name" description="Shown to your team." htmlFor="gallery-display-name">
            <ui.Input id="gallery-display-name" defaultValue="Ada" />
          </SettingsRow>
          <SettingsRow label="Notifications" htmlFor="gallery-notify">
            <ui.Switch id="gallery-notify" />
          </SettingsRow>
        </SettingsSection>
      </State>
      <State state="prompt-link" title="PromptCard, with a link">
        <PromptCard
          title="Connect your email"
          text="Add your own mailbox so conversations land in the CRM."
          action={{ label: 'Connect email', href: '/accounts' }}
        />
      </State>
      <State state="prompt-button" title="PromptCard, with a button and a body">
        <PromptCard
          title="Connect an agent"
          text="Give an agent access to your CRM."
          action={{ label: 'Show instructions', onClick: () => {} }}
        >
          <p className="text-sm">Any agent that speaks MCP can connect.</p>
        </PromptCard>
      </State>
      <State state="command" title="CommandBlock (markup characters, before and after Copy)">
        <CommandBlock command={ATTACK} />
      </State>
    </>
  )
}

function Parts() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-semibold">Vibase UI composites</h1>
      <State state="page-plain" title="SettingsPage">
        <SettingsPage title="Plain page" description="A description under the title.">
          <p className="text-sm">Content.</p>
        </SettingsPage>
      </State>
      <State state="page-actions" title="SettingsPage, with actions">
        <SettingsPage title="Page with actions" actions={<Button variant="secondary">Refresh</Button>}>
          <p className="text-sm">Content.</p>
        </SettingsPage>
      </State>
      <PageError />
      <State state="page-loading" title="SettingsPage, loading">
        <SettingsPage title="Loading page" loading>
          <p className="text-sm">Never shown.</p>
        </SettingsPage>
      </State>
      <Sections />
    </main>
  )
}

function ShellView({ manage }: { manage: boolean }) {
  return (
    <AppShell
      workspaceName="Acme CRM"
      nav={NAV}
      person={{ name: 'Ada Lovelace', email: 'ada@example.com' }}
      signOut={{ onClick: () => {} }}
      manageAccountHref={manage ? 'https://accounts.example.com/user' : undefined}
    >
      <div data-gallery-state={manage ? 'shell' : 'shell-bare'}>
        <SettingsPage title="Home" description="Your workspace.">
          <Sections />
        </SettingsPage>
      </div>
    </AppShell>
  )
}

export function Composites({ view }: { view: string }) {
  if (view === 'shell') return <ShellView manage />
  if (view === 'shell-bare') return <ShellView manage={false} />
  return <Parts />
}
