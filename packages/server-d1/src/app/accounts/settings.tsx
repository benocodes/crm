// [[UI468]] D6, D7, D8 ([[UI458]]): the settings view at `/accounts?connection=<id>`. The logic is `settings-model.ts`; this file reads the connection, draws the form (the owner with `connections:write`) or the read-only view (everyone else) and runs Save and Disconnect.
// Every string from the vault is rendered as text, never markup.
import { useEffect, useId, useRef, useState } from 'react'
import {
  Alert,
  Button,
  ChoiceGroup,
  ListEditor,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  StatusBadge,
  ui,
} from '@vibase/ui/components'
import type { Api } from '../session/api.js'
import type { ConnectionRecord } from '../session/types.js'
import { DisconnectDialog } from './disconnect-dialog.js'
import {
  buildUpdate,
  type ContactCreation,
  saveAction,
  SYSTEM_LABEL_OPTIONS,
  type SettingsValues,
  valuesFromRecord,
} from './settings-model.js'
import { disconnected, statusOf } from './view-model.js'

export type SettingsApi = Pick<Api, 'connection' | 'identityAddress' | 'updateConnection' | 'deleteConnection'>

export interface ConnectionSettingsProps {
  api: SettingsApi
  connectionId: string
  /** `me.get`'s user id: only the connection's owner edits. */
  userId: string
  scopes: readonly string[]
  /** The seam for the full-page load back to `/accounts` after Disconnect; default `window.location.assign`. */
  navigate?: (url: string) => void
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'not-connected' }
  | { kind: 'ready'; record: ConnectionRecord; address: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNREADABLE = 'The mailbox could not be read. Try again.'
const NO_ADDRESS = 'Gmail account'
const READ_ONLY_LINE = 'Only the person who connected this mailbox can change its settings.'
const CONTACT_OPTIONS: { value: ContactCreation; label: string }[] = [
  { value: 'sent', label: 'People I send mail to' },
  { value: 'sent_and_received', label: 'Everyone I exchange mail with' },
  { value: 'none', label: 'Nobody' },
]
const nameOfLabel = (id: string) => SYSTEM_LABEL_OPTIONS.find((o) => o.id === id)?.name ?? id

const BackLink = () => (
  <ui.Button asChild variant="link">
    <a href="/accounts">Back to Connected accounts</a>
  </ui.Button>
)

export function ConnectionSettings({
  api,
  connectionId,
  userId,
  scopes,
  navigate = (url) => window.location.assign(url),
}: ConnectionSettingsProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Retry's (and a refused save's) trigger: bumping it re-runs the read
  useEffect(() => {
    // D6: a malformed id is the same as an unknown one, and asks nothing.
    if (!UUID.test(connectionId)) return setLoad({ kind: 'not-connected' })
    let current = true
    setLoad({ kind: 'loading' })
    void (async () => {
      try {
        const r = await api.connection(connectionId)
        if (!current) return
        if (r.status === 404) return setLoad({ kind: 'not-connected' })
        if (r.status < 200 || r.status >= 300 || !r.body) return setLoad({ kind: 'error' })
        let address: string | null = null
        try {
          address = (await api.identityAddress(r.body.identity_id)).body
        } catch {
          address = null
        }
        if (current) setLoad({ kind: 'ready', record: r.body, address })
      } catch {
        if (current) setLoad({ kind: 'error' })
      }
    })()
    return () => {
      current = false
    }
  }, [api, connectionId, attempt])

  const address = load.kind === 'ready' ? load.address || NO_ADDRESS : null
  useEffect(() => {
    if (address) document.title = `${address} · Connected accounts · Vibase`
  }, [address])

  if (load.kind === 'not-connected')
    return (
      <SettingsPage title="Connected accounts">
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm">This mailbox is not connected.</p>
          <BackLink />
        </div>
      </SettingsPage>
    )
  if (load.kind === 'error')
    return (
      <SettingsPage title="Connected accounts" error={UNREADABLE}>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
          <BackLink />
        </div>
      </SettingsPage>
    )
  if (load.kind === 'loading')
    return (
      <SettingsPage title="Connected accounts" loading>
        {null}
      </SettingsPage>
    )

  return (
    <SettingsBody
      api={api}
      record={load.record}
      address={address ?? NO_ADDRESS}
      editable={load.record.owner_id === userId && scopes.includes('connections:write')}
      canDisconnect={scopes.includes('connections:write')}
      own={load.record.owner_id === userId}
      navigate={navigate}
      reload={() => setAttempt((n) => n + 1)}
    />
  )
}

function SettingsBody({
  api,
  record,
  address,
  editable,
  canDisconnect,
  own,
  navigate,
  reload,
}: {
  api: SettingsApi
  record: ConnectionRecord
  address: string
  editable: boolean
  canDisconnect: boolean
  own: boolean
  navigate: (url: string) => void
  reload: () => void
}) {
  const id = useId()
  const [base, setBase] = useState<SettingsValues>(() => valuesFromRecord(record))
  const [values, setValues] = useState<SettingsValues>(base)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const inFlight = useRef(false)
  const status = statusOf(record.status)

  const plan = buildUpdate(base, values)
  const edit = (next: Partial<SettingsValues>) => {
    setSaved(false)
    setValues((v) => ({ ...v, ...next }))
  }

  async function save(): Promise<void> {
    if (inFlight.current) return
    setSaved(false)
    setFormError(null)
    if (plan.kind === 'unchanged') return
    if (plan.kind === 'invalid') return setFormError(plan.message)
    inFlight.current = true
    setBusy(true)
    try {
      const r = await api.updateConnection(record.id, plan.body)
      const action = saveAction(r)
      if (action === 'saved' && r.body) {
        // D7: the form shows what the vault stored (it normalises blocked senders), not what was sent.
        const next = valuesFromRecord(r.body)
        setBase(next)
        setValues(next)
        setSaved(true)
      } else if (action === 'reload') reload()
      else setFormError(r.message ?? `The settings could not be saved (${r.code ?? r.status}). Try again.`)
    } catch {
      setFormError('The settings could not be saved. Check your connection and try again.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  async function disconnect(): Promise<void> {
    const r = await api.deleteConnection(record.id)
    if (!disconnected(r)) throw new Error(`Could not disconnect ${address} (${r.code ?? r.status}). Try again.`)
    navigate('/accounts')
  }

  return (
    <>
      <SettingsPage
        title={address}
        actions={
          <>
            <BackLink />
            {canDisconnect ? (
              <Button variant="destructive" onClick={() => setConfirming(true)}>
                Disconnect
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-2">
            <StatusBadge tone={status.tone}>{status.text}</StatusBadge>
          </div>
          {editable ? (
            <>
              <LabelsSection id={id} values={values} edit={edit} />
              <SettingsSection
                title="Blocked senders"
                description="Mail from these addresses and domains is left out of this mailbox's capture. The workspace blocklist is separate and applies as well."
              >
                <ListEditor
                  label="Blocked addresses and domains"
                  values={values.blocked}
                  onChange={(blocked) => edit({ blocked })}
                  addLabel="Add blocked sender"
                  placeholder="name@example.com or example.com"
                  emptyText="None"
                  emptyEntryMessage="Enter an address or a domain."
                  duplicateMessage="Already blocked."
                  max={500}
                  maxMessage="A mailbox can block at most 500 senders."
                />
              </SettingsSection>
              <SettingsSection title="Filters">
                <div className="flex flex-col gap-4">
                  <SettingsRow label="Leave out mail from group addresses" htmlFor={`${id}-group`}>
                    <ui.Switch
                      id={`${id}-group`}
                      checked={values.excludeGroupAddresses}
                      onCheckedChange={(excludeGroupAddresses) => edit({ excludeGroupAddresses })}
                    />
                  </SettingsRow>
                  <SettingsRow label="Leave out mail from personal email domains" htmlFor={`${id}-personal`}>
                    <ui.Switch
                      id={`${id}-personal`}
                      checked={values.excludePersonalDomains}
                      onCheckedChange={(excludePersonalDomains) => edit({ excludePersonalDomains })}
                    />
                  </SettingsRow>
                </div>
              </SettingsSection>
              <SettingsSection title="Contacts" description="This applies to mail captured from now on.">
                <ChoiceGroup
                  legend="Create contacts for"
                  name={`${id}-contacts`}
                  options={CONTACT_OPTIONS}
                  value={values.contactCreation}
                  onChange={(contactCreation) => edit({ contactCreation: contactCreation as ContactCreation })}
                />
              </SettingsSection>
              {formError ? <Alert variant="error">{formError}</Alert> : null}
              {saved ? <Alert variant="success">Saved.</Alert> : null}
              <div>
                <Button busy={busy} disabled={plan.kind === 'unchanged'} onClick={() => void save()}>
                  Save
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{READ_ONLY_LINE}</p>
              <ReadOnlySections values={base} />
            </>
          )}
        </div>
      </SettingsPage>
      {canDisconnect ? (
        <DisconnectDialog
          open={confirming}
          onOpenChange={setConfirming}
          address={address}
          anotherMembers={!own}
          onConfirm={disconnect}
        />
      ) : null}
    </>
  )
}

function LabelsSection({
  id,
  values,
  edit,
}: {
  id: string
  values: SettingsValues
  edit: (next: Partial<SettingsValues>) => void
}) {
  return (
    <SettingsSection
      title="Labels"
      description="Mail with any of these Gmail labels is captured. A label you made in Gmail is added by its id (it looks like Label_123)."
    >
      <div className="flex flex-col gap-4">
        {SYSTEM_LABEL_OPTIONS.map((o) => (
          <SettingsRow key={o.id} label={o.name} htmlFor={`${id}-${o.id}`}>
            <ui.Switch
              id={`${id}-${o.id}`}
              checked={values.labels.includes(o.id)}
              onCheckedChange={(on) =>
                edit({ labels: on ? [...values.labels, o.id] : values.labels.filter((l) => l !== o.id) })
              }
            />
          </SettingsRow>
        ))}
        <ListEditor
          label="Other labels"
          values={values.otherLabels}
          onChange={(otherLabels) => edit({ otherLabels })}
          addLabel="Add label"
          placeholder="Label_123"
          emptyText="None"
          emptyEntryMessage="Enter a label id."
          duplicateMessage="Already listed."
        />
      </div>
    </SettingsSection>
  )
}

function ReadOnlySections({ values }: { values: SettingsValues }) {
  const labels = [...values.labels.map(nameOfLabel), ...values.otherLabels]
  return (
    <>
      <SettingsSection title="Labels" readOnly>
        <SettingsRow label="Captured labels">{labels.join(', ')}</SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Blocked senders"
        description="The workspace blocklist is separate and applies as well."
        readOnly
      >
        <SettingsRow label="Blocked addresses and domains">
          {values.blocked.length > 0 ? values.blocked.join(', ') : 'None'}
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Filters" readOnly>
        <SettingsRow label="Mail from group addresses">
          {values.excludeGroupAddresses ? 'Left out' : 'Captured'}
        </SettingsRow>
        <SettingsRow label="Mail from personal email domains">
          {values.excludePersonalDomains ? 'Left out' : 'Captured'}
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Contacts" readOnly>
        <SettingsRow label="Create contacts for" description="This applies to mail captured from now on.">
          <ChoiceGroup
            legend="Create contacts for"
            name="contacts"
            options={CONTACT_OPTIONS}
            value={values.contactCreation}
            onChange={() => {}}
            readOnly
          />
        </SettingsRow>
      </SettingsSection>
    </>
  )
}
