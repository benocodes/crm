import type { Ref } from 'react'
import { useId } from 'react'

/** Group length of the displayed code (`ABCD-EFGH`); the device page's real format is fixed by [[UI247]], so it is a parameter. */
export const DEFAULT_GROUP_LENGTH = 4

/**
 * The normalised form of a typed or pasted code: letters and digits only, upper-cased, a hyphen after every `groupLength` characters.
 * Hyphen- and whitespace-insensitive, so `abcd-efgh`, `ABCDEFGH` and ` abcd efgh ` give the same `ABCD-EFGH`. A hyphen appears only once a
 * character follows it, so typing `ABCD` stays `ABCD`.
 */
export function normaliseCode(raw: string, groupLength: number = DEFAULT_GROUP_LENGTH): string {
  const chars = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const groups: string[] = []
  for (let i = 0; i < chars.length; i += groupLength) groups.push(chars.slice(i, i + groupLength))
  return groups.join('-')
}

export interface CodeInputProps {
  label: string
  /** The normalised value. */
  value: string
  onChange: (normalised: string) => void
  groupLength?: number
  /** The format hint wired by `aria-describedby`; defaults to an example built from `groupLength`. */
  hint?: string
  error?: string
  name?: string
  disabled?: boolean
  ref?: Ref<HTMLInputElement>
}

/** The device user code as one text input (one box per character handles paste and screen readers badly). */
export function CodeInput({ label, value, onChange, groupLength = DEFAULT_GROUP_LENGTH, hint, error, name, disabled, ref }: CodeInputProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = error ? `${id}-error` : undefined
  const example = `${'ABCDEFGH'.slice(0, groupLength).padEnd(groupLength, 'X')}-${'WXYZ1234'.slice(0, groupLength).padEnd(groupLength, 'X')}`
  return (
    <div className="vb-field vb-code-input">
      <label className="vb-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        ref={ref}
        className="vb-field__input vb-code-input__input"
        type="text"
        name={name}
        value={value}
        autoComplete="one-time-code"
        autoCapitalize="characters"
        // The string, not `{false}`: Preact drops a `false` attribute value, so the browser kept spellcheck on (found by the gallery run).
        spellCheck="false"
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ')}
        onChange={(e) => onChange(normaliseCode(e.currentTarget.value, groupLength))}
      />
      <p id={hintId} className="vb-field__hint">
        {hint ?? `Format: ${example}`}
      </p>
      {error ? (
        <p id={errorId} className="vb-field__error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
