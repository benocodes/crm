import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, ScopeList } from '@vibase/ui'
import { getClientName, getSession, signOut, submitConsent, type ApiFailure, type SessionUser } from './auth-api.js'
import { MESSAGES, consentReturnsTo, genericFailure } from './messages.js'
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

/**
 * [[UI247]] D4. Better Auth sends a signed-in person here with a signed query (`client_id`, `scope`, `redirect_uri`, `state`, `exp`, `sig`, ...). The page passes it back untouched as `oauth_query`
 * and only shows what it reads from it: the app (a name the app chose), the host it returns to, and the scopes. Allow and Deny are all or nothing.
 */
export function ConsentPage({ navigate = goTo }: PageProps) {
  const oauthQuery = location.search.slice(1)
  const params = new URLSearchParams(oauthQuery)
  const clientId = params.get('client_id')
  const signed = params.has('sig') && !!clientId

  const [session, setSession] = useState<SessionUser | null | undefined>(undefined)
  const [clientName, setClientName] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<'allow' | 'deny' | 'out' | undefined>(undefined)
  const alertRef = useRef<HTMLDivElement>(null)
  const toSignIn = () => navigate(`/sign-in?${oauthQuery}`)

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
    const r = await submitConsent(accept, oauthQuery)
    setBusy(undefined)
    if (r.ok) return navigate(r.data.redirect)
    if (r.status === 401) return toSignIn()
    fail(failureMessage(r))
  }
  const useAnother = async () => {
    setBusy('out')
    const r = await signOut()
    setBusy(undefined)
    if (r.ok) toSignIn()
    else fail(genericFailure(r.status))
  }
  const host = hostOf(params.get('redirect_uri'))

  return (
    <Card
      title="Allow access?"
      actions={
        <>
          <Button busy={busy === 'allow'} onClick={() => void decide(true)}>
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
      <Button variant="secondary" busy={busy === 'out'} onClick={useAnother}>
        {MESSAGES.useAnotherAccount}
      </Button>
      <p>
        <b>{clientName}</b>
      </p>
      <p>{MESSAGES.consentUnverified}</p>
      {host ? <p>{consentReturnsTo(host)}</p> : null}
      <ScopeList scopes={scopeItems((params.get('scope') ?? '').split(/\s+/))} />
    </Card>
  )
}
