// The lists page of the React gallery ([[UI458]] cycle 1, D11, P5): ResourceList, StatusBadge, ConfirmDialog, ListEditor and ChoiceGroup in
// every state. A page of its own so its bundle stays within the gallery's budget; served under `APP_CSP` (Radix's dialog injects a `<style>`).
// `?view=lists` is the page; `?view=dialog-<state>` opens one dialog state at load.
import { type ReactNode, useState } from 'react'
import {
  Button,
  ChoiceGroup,
  ConfirmDialog,
  ListEditor,
  ResourceList,
  type ResourceListItem,
  SettingsRow,
  SettingsSection,
  StatusBadge,
} from '../../src/components'

function State({ state, title, children }: { state: string; title: string; children: ReactNode }) {
  return (
    <section data-gallery-state={state} aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

const ROWS: ResourceListItem[] = [
  {
    id: 'a',
    title: 'ada@example.com',
    meta: ['Gmail', 'Synced 2 minutes ago'],
    status: <StatusBadge tone="success">Active</StatusBadge>,
    actions: [
      { label: 'Sync now', onClick: () => {} },
      { label: 'Settings', href: '/accounts?connection=a' },
      { label: 'Disconnect', onClick: () => {}, destructive: true },
    ],
  },
  {
    id: 'b',
    title: 'bob@example.com',
    meta: ['Gmail'],
    status: <StatusBadge tone="warning">Syncing</StatusBadge>,
    actions: [{ label: 'Sync now', onClick: () => {} }],
  },
  {
    id: 'c',
    title: 'cy@example.com',
    status: <StatusBadge tone="danger">Needs reconnecting</StatusBadge>,
    actions: [{ label: 'Reconnect', href: '/connect' }],
  },
  { id: 'd', title: 'dee@example.com', status: <StatusBadge>Paused</StatusBadge> },
]

const OPTIONS = [
  { value: 'all', label: 'Everything', description: 'Every message in the mailbox.' },
  { value: 'labels', label: 'Chosen labels', description: 'Only messages with a label you pick.' },
  { value: 'none', label: 'Nothing' },
]
const LIST_TEXT = {
  addLabel: 'Add',
  emptyText: 'Nothing listed.',
  emptyEntryMessage: 'Enter a value.',
  duplicateMessage: 'That value is already in the list.',
  maxMessage: 'The list is full.',
}

function Dialog({
  state,
  destructive,
  busy,
  error,
  initiallyOpen = false,
}: {
  state: string
  destructive?: boolean
  busy?: boolean
  error?: string
  initiallyOpen?: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <State
      state={state}
      title={`ConfirmDialog${destructive ? ', destructive' : ''}${busy ? ', busy' : ''}${error ? ', with an error' : ''}`}
    >
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {`Open ${state}`}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Disconnect ada@example.com?"
        description="Captured mail stays in the CRM."
        cancelLabel="Keep"
        confirmLabel="Disconnect"
        destructive={destructive}
        busy={busy}
        error={error}
        onConfirm={() => {}}
      >
        <p className="text-sm">New mail will stop arriving.</p>
      </ConfirmDialog>
    </State>
  )
}

function Lists() {
  const [domains, setDomains] = useState(['example.com'])
  const [refused, setRefused] = useState(['example.com'])
  const [choice, setChoice] = useState('all')
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-semibold">Vibase UI composites: lists, dialogs and forms</h1>
      <State state="resource-list" title="ResourceList, with rows and every tone">
        <ResourceList label="Mailboxes" items={ROWS} emptyText="No mailboxes yet." />
      </State>
      <State state="resource-empty" title="ResourceList, empty with an action">
        <ResourceList
          label="Mailboxes"
          items={[]}
          emptyText="No mailboxes yet."
          emptyAction={<Button variant="secondary">Connect Gmail</Button>}
        />
      </State>
      <State state="resource-loading" title="ResourceList, loading">
        <ResourceList label="Mailboxes" items={[]} emptyText="None" loading loadingText="Loading mailboxes…" />
      </State>
      <State state="status-badges" title="StatusBadge, every tone">
        <div className="flex flex-wrap gap-2">
          <StatusBadge>Neutral</StatusBadge>
          <StatusBadge tone="success">Success</StatusBadge>
          <StatusBadge tone="warning">Warning</StatusBadge>
          <StatusBadge tone="danger">Danger</StatusBadge>
        </div>
      </State>
      <Dialog state="dialog-opener" />
      <State state="list-editor" title="ListEditor, editable with values">
        <ListEditor label="Allowed domains" values={domains} onChange={setDomains} {...LIST_TEXT} max={5} />
      </State>
      <State state="list-editor-refusal" title="ListEditor, an inline refusal">
        <ListEditor label="Blocked domains" values={refused} onChange={setRefused} {...LIST_TEXT} max={5} />
        <p className="text-xs text-muted-foreground">Type example.com and press Enter to see the refusal.</p>
      </State>
      <State state="list-editor-readonly" title="ListEditor, read-only and empty">
        <SettingsSection title="Read-only lists">
          <ListEditor
            label="Domains"
            values={['example.com', 'acme.test']}
            onChange={() => {}}
            {...LIST_TEXT}
            readOnly
          />
          <ListEditor label="Senders" values={[]} onChange={() => {}} {...LIST_TEXT} readOnly />
        </SettingsSection>
      </State>
      <State state="choice-group" title="ChoiceGroup, editable">
        <ChoiceGroup
          legend="What to capture"
          name="gallery-capture"
          options={OPTIONS}
          value={choice}
          onChange={setChoice}
        />
      </State>
      <State state="choice-group-readonly" title="ChoiceGroup, read-only in a row">
        <SettingsSection title="Capture" readOnly>
          <SettingsRow label="What to capture">
            <ChoiceGroup
              legend="What to capture"
              name="gallery-capture-ro"
              options={OPTIONS}
              value="labels"
              onChange={() => {}}
              readOnly
            />
          </SettingsRow>
        </SettingsSection>
      </State>
    </main>
  )
}

const DIALOG_VIEWS: Record<string, { destructive?: boolean; busy?: boolean; error?: string }> = {
  'dialog-plain': {},
  'dialog-destructive': { destructive: true },
  'dialog-busy': { busy: true },
  'dialog-error': { error: 'Could not disconnect. Try again.' },
  'dialog-destructive-error': { destructive: true, error: 'Could not disconnect. Try again.' },
}

export function ListsPage({ view }: { view: string }) {
  if (view === 'lists') return <Lists />
  const dialog = DIALOG_VIEWS[view]
  if (dialog)
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-8 p-6">
        <h1 className="text-2xl font-semibold">Vibase UI composites: a dialog</h1>
        <Dialog state={view} initiallyOpen {...dialog} />
      </main>
    )
  return <Lists />
}
