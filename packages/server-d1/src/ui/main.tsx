// The mount of the auth pages' one bundle ([[UI246]] D2): the view comes from the path. This is the one file that imports `preact` itself; every other source imports `react`, which the build aliases to
// Preact ([[UI254]] D1). [[UI247]] adds the consent and device views.
import { render } from 'preact'
import { ConsentPage } from './consent-page.js'
import { DevicePage } from './device-page.js'
import { InvitePage } from './invite-page.js'
import { ResetPage } from './reset-page.js'
import { SignInPage } from './sign-in-page.js'

const path = location.pathname
const [title, view] =
  path === '/invite'
    ? (['Accept your invitation', <InvitePage />] as const)
    : path === '/reset-password'
      ? (['Set a new password', <ResetPage />] as const)
      : path === '/consent'
        ? (['Allow access', <ConsentPage />] as const)
        : path === '/device'
          ? (['Sign in from your terminal', <DevicePage />] as const)
          : (['Sign in', <SignInPage />] as const)
document.title = `${title} - Vibase`
render(view, document.getElementById('root')!)
