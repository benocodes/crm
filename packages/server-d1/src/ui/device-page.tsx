import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, CodeInput, FormLayout, ScopeList, normaliseCode } from '@vibase/ui'
import { approveDevice, claimDeviceCode, denyDevice, getClientName, getSession, signOut, type ApiFailure, type SessionUser } from './auth-api.js'
import { MESSAGES, genericFailure } from './messages.js'
import { goTo, type PageProps } from './page.js'
import { scopeItems } from './scope-text.js'

const signInLink = (): string => `/sign-in?return_to=${encodeURIComponent(location.pathname + location.search)}`
const unseparated = (code: string): string => code.replace(/-/g, '')

/** One message per result the page knows ([[UI247]] D3); anything else is the generic failure with its status. The server's own words are never shown. */
const failureMessage = (f: ApiFailure, deciding: boolean): string => {
  if (f.status === 429) return MESSAGES.rateLimited
  if (f.code === 'expired_token') return MESSAGES.deviceExpired
  if (f.code === 'invalid_request') return deciding ? MESSAGES.deviceProcessed : MESSAGES.deviceUnrecognised
  if (f.code === 'access_denied' || f.status === 403) return MESSAGES.deviceUnrecognised
  return genericFailure(f.status)
}

interface Review {
  code: string
  clientName: string
  scopes: string[]
}
type Outcome = 'approved' | 'denied' | undefined

/**
 * [[UI247]] D3. No session goes to sign-in and back; a session shows the code form (prefilled from `?user_code=`), the claim (`GET /auth/device`), the review (app, code, warning, scopes) and
 * Approve / Deny. The page never decides anything: Better Auth does, and every answer is one of this page's own messages.
 */
export function DevicePage({ navigate = goTo }: PageProps) {
  const [session, setSession] = useState<SessionUser | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void getSession().then((r) => {
      if (!live) return
      const user = r.ok && r.data ? r.data.user : null
      setSession(user)
      if (!user) navigate(signInLink())
    })
    return () => {
      live = false
    }
  }, [])
  if (!session) return null
  return <Signed user={session} navigate={navigate} />
}

function Signed({ user, navigate }: { user: SessionUser; navigate: (path: string) => void }) {
  const [code, setCode] = useState(() => normaliseCode(new URLSearchParams(location.search).get('user_code') ?? ''))
  const [codeError, setCodeError] = useState<string | undefined>(undefined)
  const [review, setReview] = useState<Review | undefined>(undefined)
  const [outcome, setOutcome] = useState<Outcome>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<'claim' | 'approve' | 'deny' | 'out' | undefined>(undefined)
  const alertRef = useRef<HTMLDivElement>(null)

  const fail = (message: string) => {
    setError(message)
    setTimeout(() => alertRef.current?.focus(), 0)
  }

  const claim = async () => {
    setError(undefined)
    if (unseparated(code) === '') {
      setCodeError(MESSAGES.deviceCodeRequired)
      return MESSAGES.fixFields
    }
    setCodeError(undefined)
    setBusy('claim')
    const r = await claimDeviceCode(unseparated(code))
    if (!r.ok) {
      setBusy(undefined)
      fail(failureMessage(r, false))
      return undefined
    }
    if (!r.data.clientId) {
      setBusy(undefined)
      fail(MESSAGES.deviceUnrecognised)
      return undefined
    }
    if (r.data.status !== 'pending') {
      setBusy(undefined)
      fail(MESSAGES.deviceProcessed)
      return undefined
    }
    const client = await getClientName(r.data.clientId)
    setBusy(undefined)
    setReview({ code, clientName: client.ok && client.data.name ? client.data.name : r.data.clientId, scopes: (r.data.scope ?? '').split(/\s+/).filter(Boolean) })
    return undefined
  }

  const decide = async (accept: boolean) => {
    setError(undefined)
    setBusy(accept ? 'approve' : 'deny')
    const r = await (accept ? approveDevice : denyDevice)(unseparated(code))
    setBusy(undefined)
    if (r.ok) setOutcome(accept ? 'approved' : 'denied')
    else fail(failureMessage(r, true))
  }

  const useAnother = async () => {
    setBusy('out')
    const r = await signOut()
    setBusy(undefined)
    if (r.ok) navigate(signInLink())
    else fail(genericFailure(r.status))
  }

  const alert = error ? (
    <Alert variant="error" ref={alertRef}>
      {error}
    </Alert>
  ) : null

  if (outcome) return <Card title={outcome === 'approved' ? 'Approved' : 'Denied'}>{outcome === 'approved' ? <p>{MESSAGES.deviceApproved}</p> : <p>{MESSAGES.deviceDenied}</p>}</Card>

  const account = (
    <div>
      <p>{`Signed in as ${user.email}`}</p>
      <Button variant="secondary" busy={busy === 'out'} onClick={useAnother}>
        {MESSAGES.useAnotherAccount}
      </Button>
    </div>
  )

  if (review) {
    return (
      <Card
        title="Approve this sign-in?"
        actions={
          <>
            <Button busy={busy === 'approve'} onClick={() => void decide(true)}>
              Approve
            </Button>
            <Button variant="secondary" busy={busy === 'deny'} onClick={() => void decide(false)}>
              Deny
            </Button>
          </>
        }
      >
        {alert}
        <p>
          <b>{review.clientName}</b>
        </p>
        <p>{review.code}</p>
        <p>{MESSAGES.deviceCheckCode}</p>
        <p>{MESSAGES.deviceWarning}</p>
        <ScopeList scopes={scopeItems(review.scopes)} />
        {account}
      </Card>
    )
  }

  return (
    <FormLayout title="Sign in from your terminal" onSubmit={claim} error={error} actions={<Button type="submit" busy={busy === 'claim'}>Check code</Button>}>
      {account}
      <CodeInput label={MESSAGES.deviceCodeLabel} name="user_code" value={code} onChange={setCode} error={codeError} />
    </FormLayout>
  )
}
