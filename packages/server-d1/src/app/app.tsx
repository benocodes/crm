// [[UI460]] D4, D7, D8 ([[UI443]]): the app's view. The shell (`AppShell`, with the visible NAV rows) renders in `ready` only; every other state is a centred card with no sidebar. Navigation is plain links with full page loads (D7).
// Every string from the vault is rendered as text, never markup.
import { useSyncExternalStore } from 'react'
import { Alert, AppShell, Button, Card } from '@vibase/ui/components'
import { AccountsPage, type AccountsApi } from './accounts/accounts.js'
import { HomePage } from './home.js'
import { NAV, visibleNav } from './nav.js'
import type { AppController, AppState } from './state.js'

export interface AppProps {
  state: AppState
  /** `clerk` or `better-auth`, from discovery; `null` when there is none. */
  provider: string | null
  /** The page path being shown (marks its nav entry current). */
  path: string
  /** The page's origin: the server the connect-an-agent commands name. */
  origin: string
  /** The MCP URL when discovery advertises one. */
  mcpUrl: string | null
  /** The client the Connected accounts page reads and connects with ([[UI467]]). */
  api: AccountsApi
  onCheckAgain(): void
  onSignIn(): void
  onSignOut(): void
  onRetry(): void
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto my-6 max-w-132 px-4">{children}</main>
}

export function App({
  state,
  provider,
  path,
  origin,
  mcpUrl,
  api,
  onCheckAgain,
  onSignIn,
  onSignOut,
  onRetry,
}: AppProps) {
  switch (state.kind) {
    case 'loading':
      return (
        <Centered>
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        </Centered>
      )
    case 'unavailable':
      return (
        <Centered>
          <Card title="Sign-in is unavailable">
            <p className="text-sm">This instance has no sign-in provider, or its configuration could not be read.</p>
          </Card>
        </Centered>
      )
    case 'signed-out':
      return (
        <Centered>
          <Card
            title="Sign in to Vibase"
            actions={
              <Button type="button" onClick={onSignIn}>
                Sign in
              </Button>
            }
          >
            <p className="text-sm">Sign in to open your workspace.</p>
          </Card>
        </Centered>
      )
    case 'no-access':
      return (
        <Centered>
          <Card
            title="No access to this workspace"
            actions={
              <Button type="button" variant="secondary" onClick={onSignOut}>
                Sign out
              </Button>
            }
          >
            {state.who ? <p className="text-sm">Signed in as {state.who}.</p> : null}
            {state.signOutError ? <Alert variant="error">{state.signOutError}</Alert> : null}
            <p className="text-sm">
              You are signed in, but this workspace has not given your account a role. Ask an owner to invite you.
            </p>
          </Card>
        </Centered>
      )
    case 'error':
      return (
        <Centered>
          <Card
            title="Something went wrong"
            actions={
              <Button type="button" onClick={onRetry}>
                Retry
              </Button>
            }
          >
            <Alert variant="error">{state.message}</Alert>
          </Card>
        </Centered>
      )
    case 'ready':
      return (
        <AppShell
          workspaceName={state.who.workspaceName}
          nav={visibleNav(NAV, { provider, scopes: state.scopes }, path)}
          person={{ name: state.who.name, email: state.who.email }}
          signOut={{ onClick: onSignOut }}
          {...(state.manageAccountHref ? { manageAccountHref: state.manageAccountHref } : {})}
        >
          {path === '/accounts' ? (
            <AccountsPage api={api} userId={state.who.userId} scopes={state.scopes} />
          ) : (
            <HomePage
              who={state.who}
              connectAgent={state.connectAgent}
              instructions={{ origin, signIn: provider !== null, mcpUrl }}
              onCheckAgain={onCheckAgain}
              {...(state.signOutError ? { error: state.signOutError } : {})}
            />
          )}
        </AppShell>
      )
  }
}

/** `App` over a controller: re-renders on every state change. */
export function AppRoot({
  controller,
  provider,
  path,
  origin,
  mcpUrl,
  api,
}: {
  controller: AppController
  provider: string | null
  path: string
  origin: string
  mcpUrl: string | null
  api: AccountsApi
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.state)
  return (
    <App
      state={state}
      provider={provider}
      path={path}
      origin={origin}
      mcpUrl={mcpUrl}
      api={api}
      onCheckAgain={() => void controller.checkAgain()}
      onSignIn={() => void controller.signIn()}
      onSignOut={() => void controller.signOut()}
      onRetry={() => void controller.retry()}
    />
  )
}
