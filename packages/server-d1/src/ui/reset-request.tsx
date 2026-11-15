import { useEffect, useState } from 'react'
import { Alert, Button, Card, Field, FormLayout } from '@vibase/ui'
import { getSelfServiceReset, requestPasswordReset } from './auth-api.js'
import { MESSAGES, genericFailure } from './messages.js'
import { emailError } from './page.js'

/** [[CORE304]] D2: whether discovery says `self_service_reset: true`. False until it says so (and whenever it cannot be read), so the "ask an owner" line is the default. */
export function useSelfServiceReset(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    void getSelfServiceReset().then((v) => {
      if (live) setOn(v)
    })
    return () => {
      live = false
    }
  }, [])
  return on
}

/**
 * [[CORE304]] D7, P4: asks for a reset link by email. Any `2xx` is the one confirmation and hides the form (a known and an unknown address are indistinguishable); `429` asks to try again later and keeps the form; any
 * other status or a network error is the page's generic message and keeps the form. No server text is rendered. A message clears on the next submit; leaving the form unmounts it, which clears it too.
 */
export function ResetRequest({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('')
  const [fieldError, setFieldError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const onSubmit = async () => {
    const problem = emailError(email.trim())
    setFieldError(problem)
    if (problem) return MESSAGES.fixFields
    setBusy(true)
    const r = await requestPasswordReset(email.trim())
    setBusy(false)
    if (r.ok) {
      setDone(true)
      return undefined
    }
    return r.status === 429 ? MESSAGES.resetRateLimited : genericFailure(r.status)
  }

  if (done)
    return (
      <Card
        title={MESSAGES.resetRequestTitle}
        actions={
          <Button variant="secondary" onClick={onBack}>
            {MESSAGES.resetRequestBack}
          </Button>
        }
      >
        <Alert variant="success">{MESSAGES.resetRequested}</Alert>
      </Card>
    )
  return (
    <FormLayout
      title={MESSAGES.resetRequestTitle}
      onSubmit={onSubmit}
      actions={
        <>
          <Button type="submit" busy={busy}>
            {MESSAGES.resetRequestSend}
          </Button>
          <Button variant="secondary" onClick={onBack}>
            {MESSAGES.resetRequestBack}
          </Button>
        </>
      }
    >
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        error={fieldError}
        required
      />
    </FormLayout>
  )
}
