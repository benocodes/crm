// The `ui-react` project's render helpers ([[UI254]] D3a): `@testing-library/react` and real React.
export { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
export { default as userEvent } from '@testing-library/user-event'
export const expectedRuntime = 'react' as const
