// The CommandBlock composite ([[UI443]] D11): a command or URL shown as text (never markup) with a Copy button. The result is announced in
// a polite live region: "Copied" clears after 3 seconds; a failure stays until the next attempt, which clears it first.
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'

export const COPIED_MS = 3000
export const COPY_FAILED = 'Could not copy. Select the text and copy it yourself.'

export interface CommandBlockProps {
  command: string
  /** Names the Copy button ("Copy <label>") when a page holds more than one block. */
  label?: string
}

export function CommandBlock({ command, label }: CommandBlockProps) {
  const [message, setMessage] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    clearTimeout(timer.current)
    setMessage('')
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(command)
      setMessage('Copied')
      timer.current = setTimeout(() => setMessage(''), COPIED_MS)
    } catch {
      setMessage(COPY_FAILED)
    }
  }

  const copied = message === 'Copied'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2 rounded-md border bg-muted p-3">
        <pre className="m-0 min-w-48 flex-1 text-sm break-all whitespace-pre-wrap">
          <code>{command}</code>
        </pre>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
          {label ? `Copy ${label}` : 'Copy'}
        </Button>
      </div>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {message}
      </p>
    </div>
  )
}
