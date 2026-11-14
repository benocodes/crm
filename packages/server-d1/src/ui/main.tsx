// The mount of the auth pages' one bundle ([[UI246]] D2): the view comes from the path. This is the one file that imports `preact` itself; every other source imports `react`, which the build aliases to
// Preact ([[UI254]] D1). [[UI247]] adds its consent and device views here.
import { render } from 'preact'
import { InvitePage } from './invite-page.js'
import { ResetPage } from './reset-page.js'
import { SignInPage } from './sign-in-page.js'

const path = location.pathname
const [title, view] =
  path === '/invite' ? (['Accept your invitation', <InvitePage />] as const) : path === '/reset-password' ? (['Set a new password', <ResetPage />] as const) : (['Sign in', <SignInPage />] as const)
document.title = `${title} - Vibase`
render(view, document.getElementById('root')!)
