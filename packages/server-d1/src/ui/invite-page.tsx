import { useState } from 'react'
import { Alert, Button, Card, Field, FormLayout } from '@vibase/ui'
import { signUp } from './auth-api.js'
import { takeFragmentToken } from './fragment.js'
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

  if (token === null) {
    return (
      <Card title="Accept your invitation">
        <Alert variant="info">{MESSAGES.inviteNoToken}</Alert>
      </Card>
    )
  }

  const onSubmit = async () => {
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
      navigate('/sign-in')
      return undefined
    }
    if (result.status === 403 && result.code === 'invitation_required') return MESSAGES.invitationRefused
    if (result.code === 'invitation_acceptance_failed') return MESSAGES.inviteAccountExists
    if (result.status === 429) return MESSAGES.rateLimited
    return genericFailure(result.status)
  }

  return (
    <FormLayout
      title="Accept your invitation"
      onSubmit={onSubmit}
      actions={
        <Button type="submit" busy={busy}>
          Create account
        </Button>
      }
    >
      <Field label="Name" name="name" autoComplete="name" value={name} onChange={setName} error={errors.name} required />
      <Field label="Email" name="email" type="email" autoComplete="email" hint="The address the invitation was sent to." value={email} onChange={setEmail} error={errors.email} required />
      <Field label="Password" name="password" type="password" autoComplete="new-password" hint="8 to 128 characters." value={password} onChange={setPassword} error={errors.password} required />
    </FormLayout>
  )
}
