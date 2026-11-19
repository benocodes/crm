// @vitest-environment happy-dom
// The sentinel ([[UI447]] D2, replacing [[UI254]] D4's): a `.test.tsx` in the shared projects (not `ui-*`) renders with real React, because no
// build or test project aliases `react` any more. If an alias comes back, `react` resolves to Preact again and this fails.
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { detectRuntime } from '../src/test/runtime'

afterEach(cleanup)

it('a .test.tsx in the shared default projects resolves `react` to React itself, not Preact', () => {
  expect(detectRuntime()).toBe('react')
  const { container } = render(<p>hi</p>)
  expect(container.textContent).toBe('hi')
})
