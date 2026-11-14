// @vitest-environment happy-dom
// Group 5, default wiring ([[UI254]] D4): a `.test.tsx` in the shared projects (not `ui-*`) renders with Preact through the default alias.
import { render } from '@testing-library/preact'
import { expect, it } from 'vitest'
import { detectRuntime } from '../src/test/runtime'

it('a .test.tsx in the shared default projects resolves `react` to Preact', () => {
  expect(detectRuntime()).toBe('preact')
  const { container } = render(<p>hi</p>)
  expect(container.textContent).toBe('hi')
})
