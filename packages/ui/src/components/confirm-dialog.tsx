import type { ReactNode } from 'react'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children?: ReactNode
  cancelLabel: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
  busy?: boolean
  error?: string
}
export function ConfirmDialog(_props: ConfirmDialogProps) {
  return null
}
