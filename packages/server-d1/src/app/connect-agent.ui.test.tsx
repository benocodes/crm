// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ConnectAgentInstructions } from './connect-agent.js'

// [[UI461]] D12, P3 (group 4): the instructions component.
afterEach(cleanup)
const ORIGIN = 'https://w.test'
const blocks = () => [...document.querySelectorAll('pre code')].map((c) => c.textContent)

describe('ConnectAgentInstructions', () => {
  it('shows the login command with the origin, the MCP URL when discovery has one, and the API-key line', () => {
    render(<ConnectAgentInstructions origin={ORIGIN} signIn mcpUrl={`${ORIGIN}/mcp`} />)
    expect(blocks()).toEqual([
      `vibase login --server ${ORIGIN}`,
      `${ORIGIN}/mcp`,
      `printf %s "$VIBASE_API_KEY" | vibase login --api-key --server ${ORIGIN}`,
    ])
    expect(screen.getByText(/an owner creates a key/i)).toBeTruthy()
  })

  it('no mcp in discovery: no MCP block', () => {
    render(<ConnectAgentInstructions origin={ORIGIN} signIn mcpUrl={null} />)
    expect(blocks()).toHaveLength(2)
    expect(screen.queryByText(/MCP/)).toBeNull()
  })

  it('no sign-in: no login command, the API-key line stays', () => {
    render(<ConnectAgentInstructions origin={ORIGIN} signIn={false} mcpUrl={null} />)
    expect(blocks()).toEqual([`printf %s "$VIBASE_API_KEY" | vibase login --api-key --server ${ORIGIN}`])
  })

  it('values render as text, never markup', () => {
    render(<ConnectAgentInstructions origin="https://<b>x</b>.test" signIn mcpUrl="<img src=x onerror=1>" />)
    expect(document.querySelector('b, img')).toBeNull()
    expect(blocks()).toContain('<img src=x onerror=1>')
  })
})
