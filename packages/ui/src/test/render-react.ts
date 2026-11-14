// The `ui-react` project's render helpers ([[UI254]] D3a): `@testing-library/react` and real React.
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

export { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
// Vitest has no globals here, so the testing library's automatic cleanup does not register: each test starts on an empty document.
afterEach(cleanup)
export { default as userEvent } from '@testing-library/user-event'
export const expectedRuntime = 'react' as const
