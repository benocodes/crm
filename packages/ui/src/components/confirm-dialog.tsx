// The ConfirmDialog composite ([[UI458]] D11, P3), on Radix `AlertDialog`: `role="alertdialog"` named by the title and described by the
// description, no dismiss on an outside click, Escape cancels, focus on Cancel at open and back to the opener at close.
// `onConfirm` may return a promise: while it is pending both buttons are disabled and the dialog is `aria-busy`; resolved, the dialog closes
// (`onOpenChange(false)`); rejected, it stays open with the error's message in an error Alert, cleared on the next attempt and on reopen.
// `busy` and `error` props override that internal state for a caller that runs the action itself.
import { AlertDialog } from 'radix-ui'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Alert } from './alert'
import { Button } from './ui/button'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  /** Extra body under the description. */
  children?: ReactNode
  cancelLabel: string
  confirmLabel: string
  /** Gives Confirm the destructive variant. */
  destructive?: boolean
  onConfirm: () => void | Promise<void>
  busy?: boolean
  error?: string
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  cancelLabel,
  confirmLabel,
  destructive = false,
  onConfirm,
  busy,
  error,
}: ConfirmDialogProps) {
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (open) setFailure(undefined)
  }, [open])
  const isBusy = busy ?? running
  const shownError = error ?? failure

  const confirm = async () => {
    setFailure(undefined)
    setRunning(true)
    try {
      await onConfirm()
      if (mounted.current) onOpenChange(false)
    } catch (e) {
      if (mounted.current) setFailure(e instanceof Error ? e.message : String(e))
    } finally {
      if (mounted.current) setRunning(false)
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => (!isBusy || next) && onOpenChange(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
        <AlertDialog.Content
          aria-busy={isBusy ? true : undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            cancelRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            opener.current?.focus()
          }}
          className="fixed top-1/2 left-1/2 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border bg-card p-6 text-card-foreground shadow-lg"
        >
          <AlertDialog.Title className="text-lg font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted-foreground">{description}</AlertDialog.Description>
          {children}
          {shownError ? <Alert variant="error">{shownError}</Alert> : null}
          <div className="flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button ref={cancelRef} variant="secondary" disabled={isBusy}>
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant={destructive ? 'destructive' : 'default'}
              disabled={isBusy}
              aria-busy={isBusy ? true : undefined}
              onClick={confirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
