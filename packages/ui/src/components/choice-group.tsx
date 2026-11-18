// The ChoiceGroup composite ([[UI458]] D11): one native choice. A `fieldset` named by its `legend` with a radio per option (label through the
// `Label` primitive, optional description as the radio's accessible description). Read-only renders just the chosen option's label as a
// `<span>`, so it sits inside a read-only `SettingsRow`'s `<dd>` (the row supplies the name).
import { useId } from 'react'
import { focusRing } from './ui/focus-ring'
import { Label } from './ui/label'
import { cn } from '../lib/utils'

export interface ChoiceOption {
  value: string
  label: string
  description?: string
}

export interface ChoiceGroupProps {
  legend: string
  /** The radios' shared `name`. */
  name: string
  options: ChoiceOption[]
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
}

export function ChoiceGroup({ legend, name, options, value, onChange, readOnly = false }: ChoiceGroupProps) {
  const id = useId()
  if (readOnly) return <span>{options.find((o) => o.value === value)?.label ?? ''}</span>
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {options.map((option, i) => {
        const inputId = `${id}-${i}`
        const descId = `${inputId}-desc`
        return (
          <div key={option.value} className="flex items-start gap-3">
            <input
              type="radio"
              id={inputId}
              name={name}
              value={option.value}
              checked={option.value === value}
              aria-describedby={option.description ? descId : undefined}
              onChange={() => onChange(option.value)}
              className={cn('mt-0.5 size-4 accent-primary', focusRing)}
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor={inputId}>{option.label}</Label>
              {option.description ? (
                <p id={descId} className="text-xs text-muted-foreground">
                  {option.description}
                </p>
              ) : null}
            </div>
          </div>
        )
      })}
    </fieldset>
  )
}
