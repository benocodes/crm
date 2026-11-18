// The Alert composite ([[UI254]] D6): `error` is `role="alert"` (announced at once), `info` and `success` are `role="status"`. `tabIndex={-1}`:
// focusable by script, not by Tab.
import type { ReactNode, Ref } from 'react'
import { Alert as AlertPrimitive } from './ui/alert'

export type AlertVariant = 'info' | 'success' | 'error'

export interface AlertProps {
  variant?: AlertVariant
  children: ReactNode
  /** Lets a form move focus here on a failed submit; `ref` is an ordinary prop. */
  ref?: Ref<HTMLDivElement>
}

const SHADCN_VARIANT = { info: 'default', success: 'success', error: 'destructive' } as const

export function Alert({ variant = 'info', children, ref }: AlertProps) {
  return (
    <AlertPrimitive
      ref={ref}
      variant={SHADCN_VARIANT[variant]}
      role={variant === 'error' ? 'alert' : 'status'}
      tabIndex={-1}
    >
      {children}
    </AlertPrimitive>
  )
}
