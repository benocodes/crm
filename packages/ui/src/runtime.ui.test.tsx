// Group 1 ([[UI254]] D3a): each project renders with the runtime it names. If `ui-react` silently resolved Preact (or the reverse), every
// other suite would pass while proving nothing, so the identity is asserted here, in each project.
import { describe, expect, it } from 'vitest'
import { expectedRuntime, render, screen } from '#render'
import { detectRuntime } from './test/runtime'

describe('runtime identity', () => {
  it('the project renders with the runtime it names', () => {
    expect(detectRuntime()).toBe(expectedRuntime)
  })

  it('renders a component through the testing library of that runtime', () => {
    render(<p>hello</p>)
    expect(screen.getByText('hello')).toBeTruthy()
  })
})
