// [[UI467]] D2, D3, D4, D12 and [[UI468]] D6, D8, D9 ([[UI458]]): the Connected accounts page. The logic is the pure view model (`view-model.ts`) and the connect return (`connect-return.ts`); this file reads the list, draws it and runs Connect Gmail / Reconnect, Sync now and Disconnect.
// `?connection=<id>` is the settings view instead of the lists (`settings.tsx`).
// Every string from the vault is rendered as text, never markup. Without `connections:read` nothing is read (D12).
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, ResourceList, SettingsPage, SettingsSection, StatusBadge } from '@vibase/ui/components'
import type { Api } from '../session/api.js'
import type { ConnectionRecord } from '../session/types.js'
import { describeReturn, takeConnectReturn } from './connect-return.js'
import { DisconnectDialog } from './disconnect-dialog.js'
import { ConnectionSettings, type SettingsApi } from './settings.js'
import { type AccountRowModel, buildAccountsView, disconnected, type RowNote, syncOutcome } from './view-model.js'

export type AccountsApi = Pick<Api, 'connections' | 'identityAddress' | 'authorizeGmail' | 'syncConnection'> &
  SettingsApi

export interface AccountsPageProps {
  api: AccountsApi
  /** `me.get`'s user id: the split of Your / Other mailboxes is by `owner_id === userId`. */
  userId: string
  /** The active organisation's scopes (`me.get`). */
  scopes: readonly string[]
  now?: () => Date
  /** The seam for the top-level navigation to Google's consent screen (D3); default `window.location.assign`. */
  navigate?: (url: string) => void
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; connections: ConnectionRecord[]; addresses: Record<string, string | null> }

const LIST_UNREADABLE = 'The mailboxes could not be read. Try again.'
const NOT_CONFIGURED = "Gmail is not set up on this instance. The instance's operator sets it up (see the setup guide)."
const CONNECT_FAILED = 'Could not start connecting. Try again.'

/** D6, D12: without `connections:read` nothing is read; `?connection=<id>` is the settings view, anything else the lists. */
export function AccountsPage(props: AccountsPageProps) {
  const [connectionId] = useState(() => new URLSearchParams(window.location.search).get('connection'))
  if (!props.scopes.includes('connections:read'))
    return (
      <SettingsPage title="Connected accounts">
        <p className="text-sm">You don't have access to connected accounts.</p>
      </SettingsPage>
    )
  if (connectionId !== null)
    return (
      <ConnectionSettings
        api={props.api}
        connectionId={connectionId}
        userId={props.userId}
        scopes={props.scopes}
        {...(props.navigate ? { navigate: props.navigate } : {})}
      />
    )
  return <AccountsList {...props} />
}

function AccountsList({
  api,
  userId,
  scopes,
  now = () => new Date(),
  navigate = (url) => window.location.assign(url),
}: AccountsPageProps) {
  // D4: before anything else, read the return from the query and remove it (other parameters kept, no navigation). A lazy initialiser: it runs once per mount, so a reload on the cleaned URL shows nothing.
  const [ret] = useState(() => {
    const taken = takeConnectReturn(window.location.search)
    if (taken.search !== window.location.search)
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + taken.search + window.location.hash,
      )
    return taken.ret
  })
  const access = scopes.includes('connections:read')
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Retry's trigger: bumping it re-runs the read
  useEffect(() => {
    if (!access) return
    let current = true
    setLoad({ kind: 'loading' })
    setNotes({})
    void (async () => {
      try {
        const list = await api.connections()
        if (!current) return
        if (list.status < 200 || list.status >= 300 || !list.body) return setLoad({ kind: 'error' })
        // P5: one address read per row, in parallel; a failed or refused read is a `null` address and does not fail the list.
        const entries = await Promise.all(
          list.body.map(async (c): Promise<[string, string | null]> => {
            try {
              return [c.id, (await api.identityAddress(c.identity_id)).body]
            } catch {
              return [c.id, null]
            }
          }),
        )
        if (current) setLoad({ kind: 'ready', connections: list.body, addresses: Object.fromEntries(entries) })
      } catch {
        if (current) setLoad({ kind: 'error' })
      }
    })()
    return () => {
      current = false
    }
  }, [api, access, attempt])

  // D3: one flow for Connect Gmail and Reconnect. Busy while waiting; the guard makes a second click (a row action has no disabled state) a no-op.
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const inFlight = useRef(false)
  async function connect(): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setNotice(null)
    let leaving = false
    try {
      const r = await api.authorizeGmail()
      if (r.status === 200 && r.body?.authorize_url) {
        leaving = true // the page is going away: it stays busy
        navigate(r.body.authorize_url)
        return
      }
      setNotice(
        r.status === 501 && r.code === 'provider_not_configured'
          ? NOT_CONFIGURED
          : `${CONNECT_FAILED} (${r.code ?? r.status})`,
      )
    } catch {
      setNotice(CONNECT_FAILED)
    } finally {
      if (!leaving) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  // [[UI468]] D9, P5: a sync outcome sits on its row until the list is read again; the guard makes a second click on a busy row a no-op.
  const [notes, setNotes] = useState<Record<string, Extract<RowNote, { kind: 'note' }>>>({})
  const syncing = useRef(new Set<string>())
  async function sync(id: string): Promise<void> {
    if (syncing.current.has(id)) return
    syncing.current.add(id)
    let outcome: RowNote
    try {
      outcome = syncOutcome(await api.syncConnection(id))
    } catch {
      outcome = { kind: 'note', text: 'Could not request a sync. Try again.' }
    } finally {
      syncing.current.delete(id)
    }
    if (outcome.kind === 'reload') setAttempt((n) => n + 1)
    else setNotes((n) => ({ ...n, [id]: outcome }))
  }

  // D8, P6: Disconnect asks first; success reads the list again and says so on the page.
  const [confirming, setConfirming] = useState<{ row: AccountRowModel } | null>(null)
  const [gone, setGone] = useState<string | null>(null)
  async function disconnect(row: AccountRowModel): Promise<void> {
    const r = await api.deleteConnection(row.id)
    if (!disconnected(r)) throw new Error(`Could not disconnect ${row.title} (${r.code ?? r.status}). Try again.`)
    setGone(`Disconnected ${row.title}.`)
    setAttempt((n) => n + 1)
  }

  const loaded = load.kind === 'ready' ? load : null
  const view = buildAccountsView({
    scopes,
    userId,
    connections: loaded?.connections ?? [],
    addresses: loaded?.addresses ?? {},
    now: now(),
  })
  if (!view.access)
    return (
      <SettingsPage title="Connected accounts">
        <p className="text-sm">You don't have access to connected accounts.</p>
      </SettingsPage>
    )

  const connectButton = view.canConnect ? (
    <Button busy={busy} onClick={() => void connect()}>
      Connect Gmail
    </Button>
  ) : undefined
  const items = (rows: AccountRowModel[]) =>
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      meta: r.meta,
      status: (
        <>
          <StatusBadge tone={r.status.tone}>{r.status.text}</StatusBadge>
          {/* P5: the outcome of Sync now, on its row, until the list is read again. */}
          {notes[r.id] ? (
            <span role="status" className="text-xs text-muted-foreground">
              {notes[r.id]?.text}
            </span>
          ) : null}
        </>
      ),
      actions: r.actions.map((a) => {
        switch (a) {
          case 'settings':
            return { label: 'Settings', href: `/accounts?connection=${encodeURIComponent(r.id)}` }
          case 'sync':
            return { label: 'Sync now', onClick: () => void sync(r.id) }
          case 'reconnect':
            return { label: 'Reconnect', onClick: () => void connect() }
          case 'disconnect':
            return { label: 'Disconnect', destructive: true, onClick: () => setConfirming({ row: r }) }
        }
      }),
    }))
  const outcome = ret
    ? describeReturn(ret, ret.kind === 'connected' ? (loaded?.addresses[ret.connectionId] ?? null) : null)
    : null

  return (
    <>
      <SettingsPage
        title="Connected accounts"
        description="The mailboxes connected to this workspace. Their conversations land in your CRM."
        {...(connectButton ? { actions: connectButton } : {})}
        loading={load.kind === 'loading'}
        {...(load.kind === 'error' ? { error: LIST_UNREADABLE } : {})}
      >
        <div className="flex flex-col gap-6">
          {outcome ? <Alert variant={outcome.variant}>{outcome.text}</Alert> : null}
          {notice ? <Alert variant="error">{notice}</Alert> : null}
          {gone ? <Alert variant="success">{gone}</Alert> : null}
          {load.kind === 'error' ? (
            <div>
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            </div>
          ) : (
            <>
              <SettingsSection title="Your mailboxes">
                <ResourceList
                  label="Your connected mailboxes"
                  items={items(view.yours)}
                  emptyText="No mailbox connected yet"
                  {...(connectButton ? { emptyAction: connectButton } : {})}
                />
              </SettingsSection>
              {view.others.length > 0 ? (
                <SettingsSection title="Other mailboxes">
                  <ResourceList
                    label="Other members' mailboxes"
                    items={items(view.others)}
                    emptyText="No other mailboxes"
                  />
                </SettingsSection>
              ) : null}
            </>
          )}
        </div>
      </SettingsPage>
      {confirming ? (
        <DisconnectDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null)
          }}
          address={confirming.row.title}
          anotherMembers={!confirming.row.own}
          onConfirm={() => disconnect(confirming.row)}
        />
      ) : null}
    </>
  )
}
