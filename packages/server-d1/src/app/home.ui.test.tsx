// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppRoot } from './app.js'
import { createApi } from './session/api.js'
import type { SessionSeam } from './session/types.js'
import { createAppController } from './state.js'

// [[UI461]] D10, D11 (group 5): Home sends nothing but GET over a full load and a Check again.
afterEach(cleanup)

describe('Home over the real API client', () => {
  it('a full load and a Check again make only GET requests, and the prompt stays with no agent', async () => {
    const calls: { method: string; url: string }[] = []
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ method: init?.method ?? 'GET', url })
      const body = url.endsWith('/meta/v1/me')
        ? {
            principal: { id: 'p', kind: 'user' },
            user: { id: 'u', email: 'ann@x.test', name: 'Ann', email_verified: true },
            agent: null,
            client_id: null,
            memberships: [{ organization_id: 'o', organization_name: 'Acme', role: 'owner' }],
            active_organization: { id: 'o', role: 'owner', scopes: ['agents:read'] },
          }
        : { data: [{ id: 'a', disabled_at: '2026-01-01' }], next_cursor: null }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    const seam: SessionSeam = {
      load: async () => {},
      isSignedIn: () => true,
      getToken: async () => 't',
      recheckSession: async () => true,
      redirectToSignIn: async () => {},
      signOut: async () => {},
      profileUrl: () => null,
    }
    const api = createApi({
      origin: 'https://w.test',
      getToken: () => seam.getToken(),
      fetch: fetchSpy as typeof fetch,
    })
    const controller = createAppController({ seam, api, origin: 'https://w.test', path: () => '/app/home' })
    render(
      <MemoryRouter initialEntries={['/app/home']}>
        <AppRoot controller={controller} provider="better-auth" origin="https://w.test" mcpUrl={null} api={api} />
      </MemoryRouter>,
    )
    await controller.start()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/agents'))).toHaveLength(2))
    expect(screen.getByRole('region', { name: 'Connect an agent' })).toBeTruthy()
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })
})
