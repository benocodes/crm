// Group 6, type half ([[UI254]] D3c): `pnpm -C packages/ui typecheck` runs this file against `@types/react`, whose JSX types reject Preact's
// spellings and unknown props. The `@ts-expect-error` lines ARE the test: removing a refused target makes the directive unused and the typecheck fail.
import { it } from 'vitest'
import { Button } from './button'
import { Field } from './field'

// Never called: it only has to type-check. (A runtime call would render nothing useful.)
export function typeChecks() {
  return (
    <>
      {/* @ts-expect-error `class` is Preact's spelling; React's types only know `className`. */}
      <div class="x" />
      {/* @ts-expect-error an unknown prop on a component is rejected. */}
      <Button nonsense="x">Save</Button>
      {/* @ts-expect-error `label` and `value` are required. */}
      <Field onChange={() => {}} />
      <Button>fine</Button>
    </>
  )
}

it('type checks are verified by tsc, not at runtime', () => {})
