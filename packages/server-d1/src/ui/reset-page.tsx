import { useState } from 'react'
import { Alert, Button, Card, Field, FormLayout } from '@vibase/ui'
import { resetPassword } from './auth-api.js'
import { takeFragmentToken } from './fragment.js'
import { MESSAGES, genericFailure } from './messages.js'
import { goTo, newPasswordError, type PageProps } from './page.js'

interface Errors {
  password?: string
  confirm?: string
}

/** [[UI246]] D6: sets a new password from a one-time link (`/reset-password#token=<token>`) an owner, or later email, hands over. */
export function ResetPage({ navigate = goTo }: PageProps) {
  const [token] = useState(takeFragmentToken)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)

  if (token === null) {
    return (
      <Card title="Set a new password">
        <Alert variant="info">{MESSAGES.resetNoToken}</Alert>
      </Card>
    )
  }

  const onSubmit = async () => {
    const found: Errors = {}
    const lengthProblem = newPasswordError(password)
    if (lengthProblem) found.password = lengthProblem
    else if (password !== confirm) found.confirm = MESSAGES.passwordMismatch
    setErrors(found)
    if (Object.keys(found).length > 0) return MESSAGES.fixFields
    setBusy(true)
    const result = await resetPassword({ newPassword: password, token })
    setBusy(false)
    if (result.ok) {
      navigate('/sign-in?notice=password-reset')
      return undefined
    }
    if (result.code === 'INVALID_TOKEN') return MESSAGES.resetInvalidLink
    if (result.code === 'PASSWORD_TOO_SHORT' || result.code === 'PASSWORD_TOO_LONG') {
      setErrors({ password: result.code === 'PASSWORD_TOO_SHORT' ? MESSAGES.passwordTooShort : MESSAGES.passwordTooLong })
      return MESSAGES.fixFields
    }
    if (result.status === 429) return MESSAGES.rateLimited
    return genericFailure(result.status)
  }

  return (
    <FormLayout
      title="Set a new password"
      onSubmit={onSubmit}
      actions={
        <Button type="submit" busy={busy}>
          Set new password
        </Button>
      }
    >
      <Field label="New password" name="new-password" type="password" autoComplete="new-password" hint="8 to 128 characters." value={password} onChange={setPassword} error={errors.password} required />
      <Field label="Confirm new password" name="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={setConfirm} error={errors.confirm} required />
    </FormLayout>
  )
}
