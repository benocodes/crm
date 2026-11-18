export interface ChoiceOption {
  value: string
  label: string
  description?: string
}
export interface ChoiceGroupProps {
  legend: string
  name: string
  options: ChoiceOption[]
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
}
export function ChoiceGroup(_props: ChoiceGroupProps) {
  return null
}
