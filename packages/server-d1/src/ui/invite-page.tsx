import { useState } from 'react'
import { Alert, Button, Card, Field, FormLayout } from '@vibase/ui/components'
import { signIn, signUp } from './auth-api.js'
import { takeFragmentToken } from './fragment.js'
import { GoogleButton, useGoogleEnabled } from './google-button.js'
import { MESSAGES, genericFailure } from './messages.js'
import { emailError, goTo, newPasswordError, type PageProps } from './page.js'

interface Errors {
  name?: string
  email?: string
  password?: string
}

/** [[UI246]] D4. There is no lookup of an invitation by token: the person types the address it was sent to, and the vault's gate decides ([[CORE287]]). */
export function InvitePage({ navigate = goTo }: PageProps) {
  // Read once, and the fragment is gone from the address before anything renders.
  const [token] = useState(takeFragmentToken)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  // [[CORE302]] P6: a person whose account already exists (a removed member invited again) signs in with the token instead of creating an account.
  const [mode, setMode] = useState<'sign-up' | 'sign-in'>('sign-up')
  const google = useGoogleEnabled()
  const [googleError, setGoogleError] = useState<string | undefined>(undefined)

  if (token === null) {
    return (
      <Card title="Accept your invitation">
        <Alert variant="info">{MESSAGES.inviteNoToken}</Alert>
      </Card>
    )
  }

  const switchMode = (next: 'sign-up' | 'sign-in') => {
    setMode(next)
    setErrors({})
  }

  const onSignIn = async () => {
    const found: Errors = {}
    const emailProblem = emailError(email.trim())
    if (emailProblem) found.email = emailProblem
    if (password === '') found.password = MESSAGES.passwordRequired
    setErrors(found)
    if (Object.keys(found).length > 0) return MESSAGES.fixFields
    setBusy(true)
    const result = await signIn({ email: email.trim(), password, invitationToken: token })
    setBusy(false)
    if (result.ok) {
      navigate('/connect')
      return undefined
    }
    if (result.code === 'invitation_acceptance_failed') return MESSAGES.signInAcceptanceFailed
    if (result.status === 401) return MESSAGES.wrongCredentials
    if (result.status === 429) return MESSAGES.rateLimited
    return genericFailure(result.status)
  }

  const onSubmit = async () => {
    setGoogleError(undefined)
    if (mode === 'sign-in') return onSignIn()
    const found: Errors = {}
    if (name.trim() === '') found.name = MESSAGES.nameRequired
    const emailProblem = emailError(email.trim())
    if (emailProblem) found.email = emailProblem
    const passwordProblem = newPasswordError(password)
    if (passwordProblem) found.password = passwordProblem
    setErrors(found)
    if (Object.keys(found).length > 0) return MESSAGES.fixFields
    setBusy(true)
    const result = await signUp({ name: name.trim(), email: email.trim(), password, invitation_token: token })
    setBusy(false)
    if (result.ok) {
      navigate('/connect')
      return undefined
    }
    if (result.status === 403 && result.code === 'invitation_required') return MESSAGES.invitationRefused
    if (result.code === 'invitation_acceptance_failed') return MESSAGES.inviteAccountExists
    if (result.status === 429) return MESSAGES.rateLimited
    return genericFailure(result.status)
  }

  const signingIn = mode === 'sign-in'
  // Top to bottom: providers (one button each; add the next provider beside GoogleButton), an OR divider, the form, the submit (in the body, so it stretches like the provider buttons), then the mode link.
  return (
    <FormLayout title="Accept your invitation" onSubmit={onSubmit} error={googleError}>
      {google ? (
        <>
          <div className="flex flex-col gap-2">
            <GoogleButton invitationToken={token} onError={setGoogleError} navigate={navigate} />
          </div>
          <div
            className="flex items-center gap-3 text-sm text-muted-foreground before:flex-1 before:border-t after:flex-1 after:border-t"
            aria-hidden="true"
          >
            OR
          </div>
        </>
      ) : null}
      <h2 className="text-base font-semibold">{signingIn ? 'Sign in' : 'Create a new account'}</h2>
      {signingIn ? null : (
        <Field
          label="Name"
          name="name"
          autoComplete="name"
          value={name}
          onChange={setName}
          error={errors.name}
          required
        />
      )}
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        hint="The address the invitation was sent to."
        value={email}
        onChange={setEmail}
        error={errors.email}
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete={signingIn ? 'current-password' : 'new-password'}
        hint={signingIn ? undefined : '8 to 128 characters.'}
        value={password}
        onChange={setPassword}
        error={errors.password}
        required
      />
      <Button type="submit" block busy={busy}>
        {signingIn ? 'Sign in' : 'Create account'}
      </Button>
      <button
        type="button"
        className="self-start text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={() => switchMode(signingIn ? 'sign-up' : 'sign-in')}
      >
        {signingIn ? 'Create an account instead' : 'Already have an account? Sign in to accept'}
      </button>
    </FormLayout>
  )
}
