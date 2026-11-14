// The `ui-preact` project's render helpers ([[UI254]] D3a): `@testing-library/preact`, the `react` alias resolving to Preact.
import { cleanup } from '@testing-library/preact'
import { afterEach } from 'vitest'

export { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact'
// Vitest has no globals here, so the testing library's automatic cleanup does not register: each test starts on an empty document.
afterEach(cleanup)
export { default as userEvent } from '@testing-library/user-event'
export const expectedRuntime = 'preact' as const
