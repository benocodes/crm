// [[UI460]] D4, D7, D8 ([[UI443]]): the app's view. The shell (`AppShell`, with the visible NAV rows) renders in `ready` only; every other state is a centred card with no sidebar. Navigation is client-side (react-router, declarative mode; reverses D7's full page loads): the router's location picks the page, the current nav row and the title.
// Every string from the vault is rendered as text, never markup.
import { useLayoutEffect, useSyncExternalStore } from 'react'
import { Link, NavLink, Route, Routes, useLocation } from 'react-router'
import { Alert, AppShell, type AppNavLinkProps, Button, Card, SettingsPage } from '@vibase/ui/components'
import { AccountsPage, type AccountsApi } from './accounts/accounts.js'
import { AgentsPage, type AgentsApi } from './agents/agents.js'
import { HomePage } from './home.js'
import { NAV, visibleNav } from './nav.js'
import type { AppController, AppState } from './state.js'

export interface AppProps {
  state: AppState
  /** `clerk` or `better-auth`, from discovery; `null` when there is none. */
  provider: string | null
  /** The page's origin: the server the connect-an-agent commands name. */
  origin: string
  /** The MCP URL when discovery advertises one. */
  mcpUrl: string | null
  /** The client the Connected accounts page reads and connects with ([[UI467]]). */
  api: AccountsApi & AgentsApi
  onCheckAgain(): void
  onSignIn(): void
  onSignOut(): void
  onRetry(): void
}

/** The nav's link: react-router's `NavLink` (the router sets `aria-current` and the active state from its location). `end` keeps a row current for its own path only. */
function RouterNavLink({ href, className, children }: AppNavLinkProps) {
  return (
    <NavLink to={href} end className={className}>
      {children}
    </NavLink>
  )
}

export const TITLES: Record<string, string> = {
  '/app/home': 'Home',
  '/app/accounts': 'Connected accounts',
  '/app/agents': 'Agents',
}

/** document.title follows the route: the page's name, `Home` for an unknown path, then ` · Vibase`. */
function useRouteTitle(): void {
  const { pathname } = useLocation()
  // A layout effect: the title is set in the same commit that draws the page, so nothing can observe the page with the previous title.
  useLayoutEffect(() => {
    document.title = `${TITLES[pathname] ?? 'Home'} · Vibase`
  }, [pathname])
}

function NotFound() {
  return (
    <SettingsPage title="Page not found">
      <p className="text-sm">There is no page at this address.</p>
      <Link to="/app/home" className="text-sm font-medium underline underline-offset-4">
        Back to Home
      </Link>
    </SettingsPage>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto my-6 max-w-132 px-4">{children}</main>
}

export function App({ state, provider, origin, mcpUrl, api, onCheckAgain, onSignIn, onSignOut, onRetry }: AppProps) {
  useRouteTitle()
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
      if (state.agent)
        return (
          <Centered>
            <Card
              title="Your agent account is ready"
              actions={
                <Button type="button" variant="secondary" onClick={onSignOut}>
                  Sign out
                </Button>
              }
            >
              {state.signOutError ? <Alert variant="error">{state.signOutError}</Alert> : null}
              <p className="text-sm">
                This invitation is claimed and the account can sign in. This app is for people, so close this page and
                sign in as the agent with <code>vibase login</code> in the CLI, or connect through the MCP or the SDK.
              </p>
            </Card>
          </Centered>
        )
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
            <p className="text-sm">This app is for people. An agent should use the MCP, the CLI or the SDK instead.</p>
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
          nav={visibleNav(NAV, { provider, scopes: state.scopes })}
          navLink={RouterNavLink}
          person={{ name: state.who.name, email: state.who.email }}
          signOut={{ onClick: onSignOut }}
          {...(state.manageAccountHref ? { manageAccountHref: state.manageAccountHref } : {})}
        >
          <Routes>
            <Route
              path="/app/accounts"
              element={<AccountsPage api={api} userId={state.who.userId} scopes={state.scopes} />}
            />
            <Route
              path="/app/agents"
              element={
                <AgentsPage
                  api={api}
                  userId={state.who.userId}
                  scopes={state.scopes}
                  instructions={{ origin, signIn: provider !== null, mcpUrl }}
                />
              }
            />
            <Route
              path="/app/home"
              element={
                <HomePage
                  who={state.who}
                  connectEmail={state.connectEmail}
                  connectAgent={state.connectAgent}
                  instructions={{ origin, signIn: provider !== null, mcpUrl }}
                  onCheckAgain={onCheckAgain}
                  {...(state.signOutError ? { error: state.signOutError } : {})}
                />
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppShell>
      )
  }
}

/** `App` over a controller: re-renders on every state change. */
export function AppRoot({
  controller,
  provider,
  origin,
  mcpUrl,
  api,
}: {
  controller: AppController
  provider: string | null
  origin: string
  mcpUrl: string | null
  api: AccountsApi & AgentsApi
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.state)
  return (
    <App
      state={state}
      provider={provider}
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
