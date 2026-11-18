import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../../lib/utils'
import { focusRing } from './focus-ring'

export const alertVariants = cva(`relative w-full rounded-lg border px-4 py-3 text-sm ${focusRing}`, {
  variants: {
    variant: {
      default: 'bg-card text-card-foreground',
      success: 'border-primary bg-card text-card-foreground',
      destructive: 'border-destructive bg-card text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
})

/** `role="alert"` as in shadcn; the composite overrides it per variant. */
export function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
}
