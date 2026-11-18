// The ListEditor composite ([[UI458]] D11): a labelled list of strings with a remove button per value and one add field. An empty entry, a
// duplicate and an add past `max` are refused inline (`aria-invalid`, the message under the field via `aria-describedby`). The input is
// trimmed before the checks; duplicates compare case-insensitively (an address or a domain is the same either way), and the value is kept as
// typed (trimmed). Each accepted change reports the whole list. The texts are props; what else a value must satisfy is the page's.
import { useId, useState } from 'react'
import { Button } from './button'
import { Input } from './ui/input'
import { Label } from './ui/label'

export interface ListEditorProps {
  label: string
  values: string[]
  onChange: (values: string[]) => void
  addLabel: string
  /** The remove button's text; its accessible name adds the value. Default "Remove". */
  removeLabel?: string
  placeholder?: string
  /** Read-only and empty: shown instead of a list. */
  emptyText: string
  emptyEntryMessage: string
  duplicateMessage: string
  /** Shown when an add is refused at `max`. */
  maxMessage?: string
  max?: number
  readOnly?: boolean
}

export function ListEditor({
  label,
  values,
  onChange,
  addLabel,
  removeLabel = 'Remove',
  placeholder,
  emptyText,
  emptyEntryMessage,
  duplicateMessage,
  maxMessage,
  max,
  readOnly = false,
}: ListEditorProps) {
  const id = useId()
  const labelId = `${id}-label`
  const messageId = `${id}-message`
  const [draft, setDraft] = useState('')
  const [refusal, setRefusal] = useState<string | undefined>(undefined)

  const add = () => {
    const value = draft.trim()
    if (max !== undefined && values.length >= max) return setRefusal(maxMessage ?? '')
    if (value === '') return setRefusal(emptyEntryMessage)
    if (values.some((v) => v.toLowerCase() === value.toLowerCase())) return setRefusal(duplicateMessage)
    setRefusal(undefined)
    setDraft('')
    onChange([...values, value])
  }

  const list =
    values.length > 0 ? (
      <ul aria-labelledby={labelId} className="flex flex-col gap-2">
        {values.map((value) => (
          <li key={value} className="flex items-center justify-between gap-3 text-sm">
            <span className="break-all">{value}</span>
            {readOnly ? null : (
              <button
                type="button"
                aria-label={`${removeLabel} ${value}`}
                className="rounded-md px-2 py-1 text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onChange(values.filter((v) => v !== value))}
              >
                {removeLabel}
              </button>
            )}
          </li>
        ))}
      </ul>
    ) : null

  if (readOnly) {
    return (
      <div className="flex flex-col gap-2">
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
        {list ?? <p className="text-sm text-muted-foreground">{emptyText}</p>}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-input`} id={labelId}>
        {label}
      </Label>
      {list}
      <div className="flex gap-2">
        <Input
          id={`${id}-input`}
          value={draft}
          placeholder={placeholder}
          aria-invalid={refusal !== undefined ? true : undefined}
          aria-describedby={refusal !== undefined ? messageId : undefined}
          onChange={(e) => {
            setDraft(e.target.value)
            setRefusal(undefined)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <Button variant="secondary" onClick={add}>
          {addLabel}
        </Button>
      </div>
      {refusal !== undefined ? (
        <p id={messageId} className="text-sm text-destructive">
          {refusal}
        </p>
      ) : null}
    </div>
  )
}
