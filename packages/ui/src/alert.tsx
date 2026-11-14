import type { ReactNode, Ref } from 'react'

export type AlertVariant = 'info' | 'success' | 'error'

export interface AlertProps {
  variant?: AlertVariant
  children: ReactNode
  /** Lets a form move focus here on a failed submit; `ref` is an ordinary prop. */
  ref?: Ref<HTMLDivElement>
}

/** `error` is `role="alert"` (announced at once); `info` and `success` are `role="status"`. `tabIndex={-1}`: focusable by script, not by Tab. */
export function Alert({ variant = 'info', children, ref }: AlertProps) {
  return (
    <div ref={ref} className={`vb-alert vb-alert--${variant}`} role={variant === 'error' ? 'alert' : 'status'} tabIndex={-1}>
      {children}
    </div>
  )
}
