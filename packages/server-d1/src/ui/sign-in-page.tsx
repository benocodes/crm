import { useEffect, useState } from 'react'
import { Alert, Button, Card, Field, FormLayout } from '@vibase/ui/components'
import { getSession, signIn, signOut, type SessionUser } from './auth-api.js'
import { MESSAGES, genericFailure } from './messages.js'
import { crossOriginTarget, returnTarget } from './continuation.js'
import { emailError, goTo, type PageProps } from './page.js'
import { GoogleButton, useGoogleEnabled } from './google-button.js'
import { ResetRequest, useSelfServiceReset } from './reset-request.js'

/** A finished sign-in with no valid `return_to` continues here: the workspace app's Home ([[UI461]] D3). */
const DEFAULT_TARGET = '/app/home'

/**
 * [[UI246]] D5. A session is the signed-in view (the email as text) with sign-out; no session is the form. No sign-up link (admission is the invitation), a "Forgot password?" request when discovery says `self_service_reset` ([[CORE304]] D7), otherwise a line saying
 * to ask an owner. [[UI247]] D6 adds the continuation: a signed OAuth query (`sig`) is forwarded as `oauth_query` and the form shows even with a session; otherwise a `return_to` of `/device`, the connect page or an app page is where a finished sign-in goes (and a signed-in visitor gets a Continue link).
 */
export function SignInPage({ navigate = goTo }: PageProps) {
  const [session, setSession] = useState<SessionUser | null | undefined>(undefined)
  const oauthQuery = new URLSearchParams(location.search).has('sig') ? location.search.slice(1) : undefined
  const target = oauthQuery === undefined ? returnTarget(location.search) : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount; the address and session are read once
  useEffect(() => {
    // An OAuth flow sent the person here to sign in (even `prompt=login` with a live session): the form, without reading the session.
    if (oauthQuery !== undefined) {
      setSession(null)
      return
    }
    let live = true
    void getSession().then((r) => {
      if (live) setSession(r.ok && r.data ? r.data.user : null)
    })
    return () => {
      live = false
    }
  }, [])

  if (session === undefined) return null
  return session ? (
    <SignedIn user={session} target={target ?? DEFAULT_TARGET} onSignedOut={() => setSession(null)} />
  ) : (
    <SignInForm
      oauthQuery={oauthQuery}
      navigate={navigate}
      onSignedIn={(_user, redirect) => {
        if (redirect !== undefined) return navigate(redirect)
        navigate(target ?? DEFAULT_TARGET)
      }}
    />
  )
}

function SignedIn({ user, target, onSignedOut }: { user: SessionUser; target: string; onSignedOut: () => void }) {
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
      <a
        className="self-start text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        href={target}
      >
        Continue
      </a>
    </Card>
  )
}

/** [[CORE294]] P1: Better Auth returns a failed Google callback as `/sign-in?error=<code>`. `invitation_required` is D4's refusal; anything else is one generic message. Neither the code nor `error_description` is ever shown. */
const callbackError = (search: string): string | undefined => {
  const code = new URLSearchParams(search).get('error')
  return code === null ? undefined : code === 'invitation_required' ? MESSAGES.invitationRefused : MESSAGES.googleFailed
}

function SignInForm({
  oauthQuery,
  navigate,
  onSignedIn,
}: {
  oauthQuery: string | undefined
  navigate: (path: string) => void
  onSignedIn: (user: SessionUser, redirect?: string) => void
}) {
  const google = useGoogleEnabled()
  // [[UI255]] D8: a cross-origin return target rides as `callbackURL`; the server's trust list decides, and only the answer's `url` is ever followed. Not with an OAuth flow in progress.
  const appTarget = oauthQuery === undefined ? crossOriginTarget(location.search) : null
  // [[CORE304]] D7: with email on the page offers a reset request instead of the "ask an owner" line; the request form replaces the sign-in form until the person goes back.
  const selfServiceReset = useSelfServiceReset()
  const [resetting, setResetting] = useState(false)
  const [googleError, setGoogleError] = useState<string | undefined>(undefined)
  // [[CORE294]] P1: the callback error is taken into state once and leaves the address, so it cannot mask a later error.
  const [callbackMessage, setCallbackMessage] = useState<string | undefined>(() => callbackError(location.search))
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    if (!q.has('error') && !q.has('error_description')) return
    q.delete('error')
    q.delete('error_description')
    const rest = q.toString()
    history.replaceState(history.state, '', location.pathname + (rest === '' ? '' : `?${rest}`) + location.hash)
  }, [])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [busy, setBusy] = useState(false)
  const notice = new URLSearchParams(location.search).get('notice') === 'password-reset'

  const onSubmit = async () => {
    setCallbackMessage(undefined)
    setGoogleError(undefined)
    const found: { email?: string; password?: string } = {}
    const emailProblem = emailError(email.trim())
    if (emailProblem) found.email = emailProblem
    if (password === '') found.password = MESSAGES.passwordRequired
    setErrors(found)
    if (Object.keys(found).length > 0) return MESSAGES.fixFields
    setBusy(true)
    const r = await signIn({
      email: email.trim(),
      password,
      ...(oauthQuery === undefined ? {} : { oauthQuery }),
      ...(appTarget === null ? {} : { callbackURL: appTarget }),
    })
    setBusy(false)
    if (r.ok) {
      onSignedIn(r.data.user ?? { email: email.trim() }, r.data.redirect)
      return undefined
    }
    if (r.code === 'invitation_acceptance_failed') return MESSAGES.signInAcceptanceFailed
    if (r.status === 401) return MESSAGES.wrongCredentials
    if (r.status === 429) return MESSAGES.rateLimited
    return genericFailure(r.status)
  }

  if (resetting) return <ResetRequest onBack={() => setResetting(false)} />
  return (
    <FormLayout
      title="Sign in"
      onSubmit={onSubmit}
      error={googleError ?? callbackMessage}
      actions={
        <Button type="submit" busy={busy}>
          Sign in
        </Button>
      }
    >
      {notice ? <Alert variant="success">{MESSAGES.passwordResetDone}</Alert> : null}
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        error={errors.email}
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        error={errors.password}
        required
      />
      {google ? (
        <GoogleButton
          callbackURL={appTarget ?? returnTarget(location.search) ?? undefined}
          onError={setGoogleError}
          navigate={navigate}
        />
      ) : null}
      {selfServiceReset ? (
        <Button variant="link" onClick={() => setResetting(true)}>
          {MESSAGES.forgotPassword}
        </Button>
      ) : (
        <p>{MESSAGES.signInHelp}</p>
      )}
    </FormLayout>
  )
}
