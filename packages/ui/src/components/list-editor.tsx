export interface ListEditorProps {
  label: string
  values: string[]
  onChange: (values: string[]) => void
  addLabel: string
  removeLabel?: string
  placeholder?: string
  emptyText: string
  emptyEntryMessage: string
  duplicateMessage: string
  maxMessage?: string
  max?: number
  readOnly?: boolean
}
export function ListEditor(_props: ListEditorProps) {
  return null
}
