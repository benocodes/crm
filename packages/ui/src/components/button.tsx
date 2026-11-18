// The Button composite ([[UI254]] D6 contract on shadcn's Button): `primary` is shadcn's `default`; `type` defaults to `button`; `busy` disables
// and sets `aria-busy`.
import type { ReactNode } from 'react'
import { cn } from '../lib/utils'
import { Button as ButtonPrimitive } from './ui/button'

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'link'

export interface ButtonProps {
  children: ReactNode
  variant?: ButtonVariant
  /** `button` unless the page asks for `submit`: a button inside a form never submits by accident. */
  type?: 'button' | 'submit'
  /** Disables the button and sets `aria-busy` while work is in flight. */
  busy?: boolean
  disabled?: boolean
  /** Fills the width of its container. */
  block?: boolean
  onClick?: () => void
}

const SHADCN_VARIANT = { primary: 'default', secondary: 'secondary', destructive: 'destructive', link: 'link' } as const

export function Button({
  children,
  variant = 'primary',
  type = 'button',
  busy = false,
  disabled = false,
  block = false,
  onClick,
}: ButtonProps) {
  return (
    <ButtonPrimitive
      type={type}
      variant={SHADCN_VARIANT[variant]}
      className={cn(block && 'w-full')}
      disabled={busy || disabled}
      aria-busy={busy ? true : undefined}
      onClick={onClick}
    >
      {children}
    </ButtonPrimitive>
  )
}
