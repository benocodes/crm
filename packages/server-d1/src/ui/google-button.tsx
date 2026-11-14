import { useEffect, useState } from 'react'
import { Button } from '@vibase/ui'
import { getSignInMethods, startGoogleSignIn } from './auth-api.js'
import { MESSAGES, genericFailure } from './messages.js'
import { goTo } from './page.js'

/** [[CORE294]] D7: whether discovery lists `google`. False until it says so (and when it cannot be read). */
export function useGoogleEnabled(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    void getSignInMethods().then((m) => {
      if (live) setOn(m.includes('google'))
    })
    return () => {
      live = false
    }
  }, [])
  return on
}

/** [[CORE294]] D8: posts to `/auth/sign-in/social` and follows the returned Google URL. A failure goes to `onError` as the page's own text. */
export function GoogleButton({ invitationToken, onError, navigate = goTo }: { invitationToken?: string; onError: (message: string) => void; navigate?: (url: string) => void }) {
  const [busy, setBusy] = useState(false)
  const click = async () => {
    setBusy(true)
    const r = await startGoogleSignIn(invitationToken)
    if (r.ok) return navigate(r.data.redirect)
    setBusy(false)
    onError(r.status === 429 ? MESSAGES.rateLimited : r.status === 0 ? genericFailure(0) : MESSAGES.googleFailed)
  }
  return (
    <Button variant="secondary" busy={busy} onClick={click}>
      {MESSAGES.googleButton}
    </Button>
  )
}
