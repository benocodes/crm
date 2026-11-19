// [[UI459]] D2, D3, D5, D6, D7, D8 ([[UI458]]): the Agents page. The logic is the pure view model (`view-model.ts`); this file reads the agents (and, with `forms:read`, the forms), draws the list and runs Disable and Enable.
// Every string from the vault is rendered as text, never markup. Without `agents:read` nothing is read (D8); Connect an agent is always shown (D2).
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  CommandBlock,
  ConfirmDialog,
  ResourceList,
  SettingsPage,
  SettingsSection,
  StatusBadge,
} from '@vibase/ui/components'
import { ConnectAgentInstructions, type ConnectAgentInstructionsProps } from '../connect-agent.js'
import type { Api } from '../session/api.js'
import type { AgentRecord } from '../session/types.js'
import { type AgentRowModel, buildAgentsView, toggleOutcome } from './view-model.js'

export type AgentsApi = Pick<Api, 'agents' | 'forms' | 'setDisabled'>

export interface AgentsPageProps {
  api: AgentsApi
  /** `me.get`'s user id: for a user it is the principal id `delegated_by` is compared with. */
  userId: string
  /** The active organisation's scopes (`me.get`). */
  scopes: readonly string[]
  /** Home's props for the instructions (D2). */
  instructions: ConnectAgentInstructionsProps
  /** Dates in the browser's locale, date only (D3); a seam so tests pin them. */
  formatDate?: (iso: string) => string
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; agents: AgentRecord[]; forms: ReadonlyMap<string, string> | null }

const LIST_UNREADABLE = 'The agents could not be read. Try again.'
const NO_ACCESS = "You don't have access to the agents list."
const DESCRIPTION = 'Agents act in this CRM with the permissions an owner grants them.'
const NOTES =
  "An agent's access is its stored permissions, further bounded by what was approved on the consent screen and by the role of the person who delegated it. Your own `vibase login` is you, not an agent, so it is not listed here (`vibase logout`, or signing out of all your sessions, ends it)."
const EMPTY = 'No agents connected yet. Connect one with the instructions below.'

const defaultFormat = (iso: string): string => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(at)
}

export function AgentsPage({ api, userId, scopes, instructions, formatDate = defaultFormat }: AgentsPageProps) {
  const access = scopes.includes('agents:read')
  const readForms = scopes.includes('forms:read')
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Retry's trigger: bumping it re-runs the read
  useEffect(() => {
    if (!access) return
    let current = true
    setLoad({ kind: 'loading' })
    void (async () => {
      try {
        // D6: a failed or forbidden forms read leaves the rows unmarked and does not fail the page.
        const formsRead = readForms
          ? api.forms().then(
              (r) => (r.status >= 200 && r.status < 300 && r.body ? new Map(r.body.map((f) => [f.id, f.name])) : null),
              () => null,
            )
          : Promise.resolve(null)
        const [list, forms] = await Promise.all([api.agents(), formsRead])
        if (!current) return
        if (list.status < 200 || list.status >= 300 || !list.body) return setLoad({ kind: 'error' })
        setLoad({ kind: 'ready', agents: list.body, forms })
      } catch {
        if (current) setLoad({ kind: 'error' })
      }
    })()
    return () => {
      current = false
    }
  }, [api, access, readForms, attempt])

  const [announce, setAnnounce] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<AgentRowModel | null>(null)
  const toggling = useRef(new Set<string>())

  function replace(record: AgentRecord): void {
    setLoad((l) => (l.kind === 'ready' ? { ...l, agents: l.agents.map((a) => (a.id === record.id ? record : a)) } : l))
  }

  // D5: Enable acts at once; a failure is a page Alert. The guard makes a second click on a busy row a no-op.
  async function enable(row: AgentRowModel): Promise<void> {
    if (toggling.current.has(row.id)) return
    toggling.current.add(row.id)
    setAnnounce(null)
    setPageError(null)
    try {
      const out = toggleOutcome(await api.setDisabled(row.id, false), row.name, false)
      if (out.kind === 'updated') {
        replace(out.record)
        setAnnounce(out.announce)
      } else if (out.kind === 'reload') setAttempt((n) => n + 1)
      else setPageError(out.text)
    } catch {
      setPageError(`Could not enable ${row.name}. Try again.`)
    } finally {
      toggling.current.delete(row.id)
    }
  }

  // D5: Disable asks first. `onConfirm` rejects with the words to show, which keeps the dialog open.
  async function disable(row: AgentRowModel): Promise<void> {
    setAnnounce(null)
    setPageError(null)
    let out: ReturnType<typeof toggleOutcome>
    try {
      out = toggleOutcome(await api.setDisabled(row.id, true), row.name, true)
    } catch {
      throw new Error(`Could not disable ${row.name}. Try again.`)
    }
    if (out.kind === 'updated') {
      replace(out.record)
      setAnnounce(out.announce)
    } else if (out.kind === 'reload') setAttempt((n) => n + 1)
    else throw new Error(out.text)
  }

  const loaded = load.kind === 'ready' ? load : null
  const view = useMemo(
    () =>
      buildAgentsView({
        scopes,
        meId: userId,
        agents: loaded?.agents ?? [],
        forms: loaded?.forms ?? null,
        formatDate,
      }),
    [scopes, userId, loaded, formatDate],
  )

  const items = view.rows.map((r) => ({
    id: r.id,
    title: r.name,
    meta: r.meta,
    status: <StatusBadge tone={r.status.tone}>{r.status.text}</StatusBadge>,
    ...(r.grantCommand
      ? {
          detail: (
            <>
              <p className="text-sm">It has no permissions yet. To grant some, run:</p>
              <CommandBlock command={r.grantCommand} label="grant command" />
            </>
          ),
        }
      : {}),
    actions: r.action
      ? [
          r.action === 'disable'
            ? { label: 'Disable', destructive: true, onClick: () => setConfirming(r) }
            : { label: 'Enable', onClick: () => void enable(r) },
        ]
      : [],
  }))

  return (
    <>
      <SettingsPage
        title="Agents"
        description={DESCRIPTION}
        loading={access && load.kind === 'loading'}
        {...(load.kind === 'error' ? { error: LIST_UNREADABLE } : {})}
      >
        <div className="flex flex-col gap-6">
          {announce ? (
            <p role="status" className="text-sm">
              {announce}
            </p>
          ) : null}
          {pageError ? <Alert variant="error">{pageError}</Alert> : null}
          <SettingsSection title="Connected agents" description={NOTES}>
            {!access ? (
              <p className="text-sm">{NO_ACCESS}</p>
            ) : load.kind === 'error' ? (
              <div>
                <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                  Retry
                </Button>
              </div>
            ) : (
              <ResourceList label="Connected agents" items={items} emptyText={EMPTY} />
            )}
          </SettingsSection>
          <SettingsSection title="Connect an agent">
            <ConnectAgentInstructions {...instructions} headingLevel={3} />
          </SettingsSection>
        </div>
      </SettingsPage>
      {confirming ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null)
          }}
          title={`Disable ${confirming.name}?`}
          description={`${confirming.name} stops working at once: its API keys and sign-ins are refused until you enable it again. Nothing it did is undone.`}
          cancelLabel="Cancel"
          confirmLabel="Disable"
          destructive
          onConfirm={() => disable(confirming)}
        />
      ) : null}
    </>
  )
}
