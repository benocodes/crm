import { useEffect, useState } from 'react'
import { Alert, Button, Card, Field, FormLayout } from '@vibase/ui'
import { getSession, signIn, signOut, type SessionUser } from './auth-api.js'
import { MESSAGES, genericFailure } from './messages.js'
import { emailError, goTo, type PageProps } from './page.js'

/**
 * [[UI246]] D5. A session is the signed-in view (the email as text) with sign-out; no session is the form. No sign-up link (admission is the invitation), no "forgot password" flow without email (a line says
 * to ask an owner), and no continuation: an OAuth authorize redirect lands here, but forwarding its signed query is [[UI247]]'s.
 */
export function SignInPage(_props: PageProps) {
  const [session, setSession] = useState<SessionUser | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void getSession().then((r) => {
      if (live) setSession(r.ok && r.data ? r.data.user : null)
    })
    return () => {
      live = false
    }
  }, [])

  if (session === undefined) return null
  return session ? <SignedIn user={session} onSignedOut={() => setSession(null)} /> : <SignInForm onSignedIn={setSession} />
}

function SignedIn({ user, onSignedOut }: { user: SessionUser; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const out = async () => {
    setBusy(true)
    const r = await signOut()
    setBusy(false)
    if (r.ok) onSignedOut()
    else setError(genericFailure(r.status))
  }
  return (
    <Card
      title="Signed in"
      actions={
        <Button variant="secondary" busy={busy} onClick={out}>
          Sign out
        </Button>
      }
    >
      {error ? <Alert variant="error">{error}</Alert> : null}
      <p>{`Signed in as ${user.email}`}</p>
    </Card>
  )
}

function SignInForm({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [busy, setBusy] = useState(false)
  const notice = new URLSearchParams(location.search).get('notice') === 'password-reset'

  const onSubmit = async () => {
    const found: { email?: string; password?: string } = {}
    const emailProblem = emailError(email.trim())
    if (emailProblem) found.email = emailProblem
    if (password === '') found.password = MESSAGES.passwordRequired
    setErrors(found)
    if (Object.keys(found).length > 0) return MESSAGES.fixFields
    setBusy(true)
    const r = await signIn({ email: email.trim(), password })
    setBusy(false)
    if (r.ok) {
      onSignedIn(r.data.user ?? { email: email.trim() })
      return undefined
    }
    if (r.code === 'invitation_acceptance_failed') return MESSAGES.signInAcceptanceFailed
    if (r.status === 401) return MESSAGES.wrongCredentials
    if (r.status === 429) return MESSAGES.rateLimited
    return genericFailure(r.status)
  }

  return (
    <FormLayout
      title="Sign in"
      onSubmit={onSubmit}
      actions={
        <Button type="submit" busy={busy}>
          Sign in
        </Button>
      }
    >
      {notice ? <Alert variant="success">{MESSAGES.passwordResetDone}</Alert> : null}
      <Field label="Email" name="email" type="email" autoComplete="email" value={email} onChange={setEmail} error={errors.email} required />
      <Field label="Password" name="password" type="password" autoComplete="current-password" value={password} onChange={setPassword} error={errors.password} required />
      <p>{MESSAGES.signInHelp}</p>
    </FormLayout>
  )
}
