import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Button, Card, ScopeList, ui } from '@vibase/ui/components'
import { getClientName, getSession, signOut, submitConsent, type ApiFailure, type SessionUser } from './auth-api.js'
import {
  buildConsentModel,
  defaultState,
  effectiveOn,
  grantedScopes,
  type AreaModel,
  type SwitchState,
} from './consent-model.js'
import { MESSAGES, consentReturnsTo, genericFailure, permissionsOf, showPermissions } from './messages.js'
import { goTo, type PageProps } from './page.js'
import { scopeItems } from './scope-text.js'

const hostOf = (uri: string | null): string | undefined => {
  if (!uri) return undefined
  try {
    return new URL(uri).host || undefined
  } catch {
    return undefined
  }
}

/** One message per result ([[UI247]] D4). `401` is handled by the caller (it goes to sign-in); the server's own words are never shown. */
const failureMessage = (f: ApiFailure): string => {
  if (f.status === 429) return MESSAGES.rateLimited
  if (f.code === 'invalid_signature' || f.code === 'invalid_request') return MESSAGES.consentInvalid
  return genericFailure(f.status)
}

/** [[UI455]] P5: every requested scope of a group as text, behind a closed disclosure that counts them. */
function Disclosure({ scopes, label }: { scopes: readonly string[]; label: string }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">{showPermissions(scopes.length)}</summary>
      <ScopeList label={label} scopes={scopeItems(scopes)} />
    </details>
  )
}

function Area({ area, state, setState }: { area: AreaModel; state: SwitchState; setState: (s: SwitchState) => void }) {
  const uid = useId()
  const model = { requested: [], signIn: [], areas: [area] }
  const legendId = `${uid}-legend`
  const write = area.switches.find((w) => w.kind === 'write')
  const forced = !!write && !!state[write.id]
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border p-3">
      <legend id={legendId} className="px-1 font-medium">
        {area.name}
      </legend>
      <p className="text-sm text-muted-foreground">{area.sentence}</p>
      {area.switches.map((w) => {
        const labelId = `${uid}-${w.id}`
        const lock = w.kind === 'request_approval' && forced
        return (
          <div key={w.id} className="flex items-center gap-2">
            <ui.Switch
              id={`${labelId}-switch`}
              aria-labelledby={`${legendId} ${labelId}`}
              checked={effectiveOn(model, state, w)}
              disabled={lock}
              onCheckedChange={(on) => setState({ ...state, [w.id]: on })}
            />
            <ui.Label id={labelId} htmlFor={`${labelId}-switch`}>
              {w.label}
            </ui.Label>
          </div>
        )
      })}
      {forced ? <p className="text-sm text-muted-foreground">{MESSAGES.writeIncludesPropose}</p> : null}
      <Disclosure scopes={area.requested} label={permissionsOf(area.name)} />
    </fieldset>
  )
}

/**
 * [[UI247]] D4, grouped by [[UI449]]. Better Auth sends a signed-in person here with a signed query (`client_id`, `scope`, `redirect_uri`, `state`, `exp`, `sig`, ...). The page passes it back untouched as `oauth_query`
 * and shows what it reads from it: the app (a name the app chose), the host it returns to, and the scopes grouped into areas with Read, Propose and Write switches ([[UI455]]; the model is `consent-model.ts`).
 * Allow sends the `scope` that is switched on beside the query; Deny sends none.
 */
export function ConsentPage({ navigate = goTo }: PageProps) {
  const oauthQuery = location.search.slice(1)
  const params = new URLSearchParams(oauthQuery)
  const clientId = params.get('client_id')
  const signed = params.has('sig') && !!clientId

  const [session, setSession] = useState<SessionUser | null | undefined>(undefined)
  const [clientName, setClientName] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const model = buildConsentModel((params.get('scope') ?? '').split(/\s+/))
  const [state, setState] = useState<SwitchState>(() => defaultState(model))
  const [busy, setBusy] = useState<'allow' | 'deny' | 'out' | undefined>(undefined)
  const alertRef = useRef<HTMLDivElement>(null)
  const toSignIn = () => navigate(`/sign-in?${oauthQuery}`)

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount; the page reads its address and session once
  useEffect(() => {
    if (!signed) return
    let live = true
    void getSession().then(async (r) => {
      if (!live) return
      const user = r.ok && r.data ? r.data.user : null
      if (!user) return toSignIn()
      const client = await getClientName(clientId!)
      if (!live) return
      setClientName(client.ok && client.data.name ? client.data.name : clientId!)
      setSession(user)
    })
    return () => {
      live = false
    }
  }, [])

  if (!signed) return <Card title="Nothing to approve">{<p>{MESSAGES.consentNoRequest}</p>}</Card>
  if (!session) return null

  const fail = (message: string) => {
    setError(message)
    setTimeout(() => alertRef.current?.focus(), 0)
  }
  const decide = async (accept: boolean) => {
    setError(undefined)
    setBusy(accept ? 'allow' : 'deny')
    const r = await submitConsent(accept, oauthQuery, accept ? grantedScopes(model, state) : undefined)
    setBusy(undefined)
    if (r.ok) return navigate(r.data.redirect)
    if (r.status === 401) return toSignIn()
    fail(failureMessage(r))
  }
  const signInAsAnother = async () => {
    setBusy('out')
    const r = await signOut()
    setBusy(undefined)
    if (r.ok) toSignIn()
    else fail(genericFailure(r.status))
  }
  const host = hostOf(params.get('redirect_uri'))
  const nothingOn = grantedScopes(model, state) === ''

  return (
    <Card
      title="Allow access?"
      actions={
        <>
          <Button busy={busy === 'allow'} disabled={nothingOn} onClick={() => void decide(true)}>
            Allow
          </Button>
          <Button variant="secondary" busy={busy === 'deny'} onClick={() => void decide(false)}>
            Deny
          </Button>
        </>
      }
    >
      {error ? (
        <Alert variant="error" ref={alertRef}>
          {error}
        </Alert>
      ) : null}
      <p>{`Signed in as ${session.email}`}</p>
      <Button variant="secondary" busy={busy === 'out'} onClick={signInAsAnother}>
        {MESSAGES.useAnotherAccount}
      </Button>
      <p>
        <b>{clientName}</b>
      </p>
      <p>{MESSAGES.consentUnverified}</p>
      {host ? <p>{consentReturnsTo(host)}</p> : null}
      {model.signIn.length > 0 ? (
        <div data-testid="sign-in-line" className="flex flex-col gap-1">
          <p>
            <b>{MESSAGES.consentSignInTitle}</b>
          </p>
          <p className="text-sm text-muted-foreground">{MESSAGES.consentSignInSentence}</p>
          <Disclosure scopes={model.signIn} label={MESSAGES.signInPermissions} />
        </div>
      ) : null}
      {model.areas.length > 0 ? (
        <section
          aria-label={MESSAGES.areasLabel}
          className="flex max-h-[clamp(10rem,32vh,20rem)] flex-col gap-3 overflow-y-auto"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard focusable (axe scrollable-region-focusable)
          tabIndex={0}
        >
          {model.areas.map((area) => (
            <Area key={area.key} area={area} state={state} setState={setState} />
          ))}
        </section>
      ) : null}
      {nothingOn ? <p className="text-sm">{MESSAGES.consentNothingOn}</p> : null}
    </Card>
  )
}
