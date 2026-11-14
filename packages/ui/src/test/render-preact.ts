// The `ui-preact` project's render helpers ([[UI254]] D3a): `@testing-library/preact`, the `react` alias resolving to Preact.
export { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact'
export { default as userEvent } from '@testing-library/user-event'
export const expectedRuntime = 'preact' as const
