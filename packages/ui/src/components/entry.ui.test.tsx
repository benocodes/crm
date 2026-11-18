// [[UI448]] group 2: `@vibase/ui/components` exports every D7 component, and the composites accept the Preact layer's exported props types
// ([[UI254]]'s props unchanged, P3). The type half is checked by `pnpm -C packages/ui typecheck`; the `@ts-expect-error` lines ARE the test.
import { describe, expect, it } from 'vitest'
import { render, screen } from '#render'
import type {
  AlertProps,
  ButtonProps,
  CardProps,
  CodeInputProps,
  FieldProps,
  FormLayoutProps,
  ScopeItem,
} from '../index'
import { DEFAULT_GROUP_LENGTH as PREACT_GROUP, normaliseCode as preactNormalise } from '../index'
import * as entry from './index'

describe('@vibase/ui/components entry', () => {
  it('exports every D7 component and the code helpers', () => {
    expect(Object.keys(entry).sort()).toEqual(
      [
        'Alert',
        'Button',
        'Card',
        'CodeInput',
        'DEFAULT_GROUP_LENGTH',
        'Field',
        'FormLayout',
        'ScopeList',
        'normaliseCode',
        'ui',
      ].sort(),
    )
    expect(Object.keys(entry.ui).sort()).toEqual(
      ['Alert', 'Button', 'Card', 'CardContent', 'CardFooter', 'CardHeader', 'CardTitle', 'Input', 'Label'].sort(),
    )
  })

  it('has the same code helper behaviour as the Preact layer', () => {
    expect(entry.DEFAULT_GROUP_LENGTH).toBe(PREACT_GROUP)
    for (const raw of ['abcd-efgh', ' abcd efgh ', 'abcde', ''])
      expect(entry.normaliseCode(raw)).toBe(preactNormalise(raw))
  })

  it('renders a composite from the entry', () => {
    render(<entry.Button>Go</entry.Button>)
    expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy()
  })
})

// Never called: it only has to type-check.
export function typeChecks() {
  const button: ButtonProps = { children: 'x', variant: 'destructive', block: true, busy: true, onClick: () => {} }
  const field: FieldProps = { label: 'l', value: '', onChange: () => {}, hint: 'h', error: 'e', autoComplete: 'email' }
  const card: CardProps = { title: 't', children: 'c', actions: 'a', headingLevel: 2 }
  const form: FormLayoutProps = { title: 't', children: 'c', onSubmit: () => 'bad', error: 'e' }
  const scopes: ScopeItem[] = [{ name: 'a', description: 'b' }]
  const code: CodeInputProps = { label: 'l', value: '', onChange: () => {}, groupLength: 3 }
  const alert: AlertProps = { variant: 'success', children: 'c' }
  return (
    <>
      <entry.Button {...button} />
      <entry.Field {...field} />
      <entry.Card {...card} />
      <entry.FormLayout {...form} />
      <entry.ScopeList scopes={scopes} />
      <entry.CodeInput {...code} />
      <entry.Alert {...alert} />
      {/* @ts-expect-error `ghost` is shadcn's variant, not the contract's. */}
      <entry.Button variant="ghost">No</entry.Button>
      {/* @ts-expect-error `label` and `value` are required. */}
      <entry.Field onChange={() => {}} />
    </>
  )
}
