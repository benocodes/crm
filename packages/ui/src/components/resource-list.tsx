import type { ReactNode } from 'react'

export interface ResourceRowAction {
  label: string
  onClick?: () => void
  href?: string
  destructive?: boolean
}
export interface ResourceListItem {
  id: string
  title: string
  meta?: string[]
  status?: ReactNode
  actions?: ResourceRowAction[]
}
export interface ResourceListProps {
  label: string
  items: ResourceListItem[]
  emptyText: string
  emptyAction?: ReactNode
  loading?: boolean
  loadingText?: string
}
export function ResourceList(_props: ResourceListProps) {
  return null
}
