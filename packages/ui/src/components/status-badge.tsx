import type { ReactNode } from 'react'

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger'
export interface StatusBadgeProps {
  tone?: StatusTone
  children: ReactNode
}
export function StatusBadge(_props: StatusBadgeProps) {
  return null
}
