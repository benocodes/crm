// @vitest-environment happy-dom
// [[UI446]] D3: the page suites run on real React. If this project silently resolved Preact (a Preact alias), every page suite
// would pass while proving nothing about the runtime that ships, so the identity is asserted here.
import * as React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('the page project runs real React', () => {
  it('react resolves to React itself, not preact/compat', () => {
    // `preact/compat` does not export React's client internals; real React does (the sentinel in packages/ui/scripts/default-runtime.test.tsx makes the same check).
    expect('__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE' in React).toBe(true)
  })

  it('renders through @testing-library/react', () => {
    render(<p>hello</p>)
    expect(screen.getByText('hello')).toBeTruthy()
  })
})
