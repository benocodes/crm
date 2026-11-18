// The mount of the auth pages' one bundle ([[UI246]] D2, [[UI446]] D1, D2): the view comes from the path. This is the one file that imports `react-dom`; the pages run on real React and `@vibase/ui/components`.
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConsentPage } from './consent-page.js'
import { DevicePage } from './device-page.js'
import { InvitePage } from './invite-page.js'
import { ResetPage } from './reset-page.js'
import { SignInPage } from './sign-in-page.js'

const pageFor = (path: string): { title: string; view: ReactNode } => {
  switch (path) {
    case '/invite':
      return { title: 'Accept your invitation', view: <InvitePage /> }
    case '/reset-password':
      return { title: 'Set a new password', view: <ResetPage /> }
    case '/consent':
      return { title: 'Allow access', view: <ConsentPage /> }
    case '/device':
      return { title: 'Sign in from your terminal', view: <DevicePage /> }
    default:
      return { title: 'Sign in', view: <SignInPage /> }
  }
}
const { title, view } = pageFor(location.pathname)
document.title = `${title} - Vibase`
// The page column the Preact layer's card carried (a 28rem column, centred, 1.5rem above and below).
createRoot(document.getElementById('root')!).render(<div className="mx-auto my-6 max-w-md">{view}</div>)
