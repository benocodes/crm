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
// The page column the Preact layer's card carried: 28rem of content plus 1.5rem padding each side (31rem), centred, 1.5rem above and below, plus a 1rem gutter so a narrow screen keeps a margin (33rem with the gutters).
// No transitions: the Preact layer had none, and a colour-scheme change must show at once (a transitioning button is mid-colour for 150 ms, which axe's contrast check and a screenshot both catch).
createRoot(document.getElementById('root')!).render(
  <div className="mx-auto my-6 max-w-132 px-4 [&_*]:transition-none!">{view}</div>,
)
