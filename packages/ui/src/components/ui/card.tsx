import { Slot } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../../lib/utils'

type WithAsChild<T> = T & { asChild?: boolean }

export function Card({ className, asChild = false, ...props }: WithAsChild<React.ComponentProps<'div'>>) {
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      data-slot="card"
      className={cn('flex flex-col gap-4 rounded-xl border bg-card py-6 text-card-foreground shadow-sm', className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1.5 px-6', className)} {...props} />
}

export function CardTitle({ className, asChild = false, ...props }: WithAsChild<React.ComponentProps<'div'>>) {
  const Comp = asChild ? Slot.Root : 'div'
  return <Comp data-slot="card-title" className={cn('leading-none font-semibold', className)} {...props} />
}

export function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('flex flex-col gap-4 px-6', className)} {...props} />
}

export function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('flex items-center gap-2 px-6', className)} {...props} />
}
