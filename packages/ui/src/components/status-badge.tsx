// The StatusBadge composite ([[UI458]] D11): a short status label with a tone. The text always carries the meaning; the tone only tints it
// (`data-tone` names it for tests and styling), so no meaning rests on colour alone.
import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface StatusBadgeProps {
  tone?: StatusTone
  children: ReactNode
}

const TONE: Record<StatusTone, string> = {
  neutral: 'border-border text-muted-foreground',
  success: 'border-primary text-foreground',
  warning: 'border-yellow-600 text-foreground dark:border-yellow-500',
  danger: 'border-destructive text-destructive',
}

export function StatusBadge({ tone = 'neutral', children }: StatusBadgeProps) {
  return (
    <span
      data-tone={tone}
      className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', TONE[tone])}
    >
      {children}
    </span>
  )
}
