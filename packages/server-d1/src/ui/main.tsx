// The mount of the auth pages' one bundle ([[UI246]] D2, [[UI446]] D1, D2): the view comes from the path. This is the one file that imports `react-dom`; the pages run on real React and `@vibase/ui/components`.
import { createRoot } from 'react-dom/client'
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
// The page column the Preact layer's card carried (a 28rem column, centred, 1.5rem above and below).
createRoot(document.getElementById('root')!).render(<div className="mx-auto my-6 max-w-md">{view}</div>)
