import type { Ref } from 'react'
import { useId } from 'react'

export interface FieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url'
  name?: string
  /** Passed through: sign-in pages need `email`, `current-password`, `new-password`. */
  autoComplete?: string
  hint?: string
  /** An error message. `aria-invalid` is present only while this is set (absent otherwise, never `"false"`). */
  error?: string
  required?: boolean
  disabled?: boolean
  /** `ref` is an ordinary prop (React 19, Preact 11): it reaches the input. */
  ref?: Ref<HTMLInputElement>
}

export function Field({ label, value, onChange, type = 'text', name, autoComplete, hint, error, required, disabled, ref }: FieldProps) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return (
    <div className="vb-field">
      <label className="vb-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        ref={ref}
        className="vb-field__input"
        type={type}
        name={name}
        value={value}
        autoComplete={autoComplete}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      {hint ? (
        <p id={hintId} className="vb-field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="vb-field__error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
