import type { ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'link'

export interface ButtonProps {
  children: ReactNode
  variant?: ButtonVariant
  /** `button` unless the page asks for `submit`: a button inside a form never submits by accident. */
  type?: 'button' | 'submit'
  /** Disables the button and sets `aria-busy` while work is in flight. */
  busy?: boolean
  disabled?: boolean
  onClick?: () => void
}

export function Button({ children, variant = 'primary', type = 'button', busy = false, disabled = false, onClick }: ButtonProps) {
  return (
    <button
      type={type}
      className={`vb-button vb-button--${variant}`}
      disabled={busy || disabled}
      aria-busy={busy ? true : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
