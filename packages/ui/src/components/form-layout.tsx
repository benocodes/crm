// The FormLayout composite ([[UI254]] D6): `<form noValidate>`; a failed submit shows the message in an error Alert and moves focus there.
import type { FormEvent, ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Alert } from './alert'
import { Card, type CardProps } from './card'

export type SubmitResult = string | null | undefined | void

export interface FormLayoutProps extends Omit<CardProps, 'children'> {
  children: ReactNode
  /**
   * Runs on submit (Enter in a field or the submit button). Returns an error message to fail validation, or nothing to succeed.
   * A failure shows the message in the form's error Alert and moves focus there.
   */
  onSubmit: () => SubmitResult | Promise<SubmitResult>
  /** An error the page sets itself (a server answer); shown in the same Alert, which then takes focus too. */
  error?: string
}

export function FormLayout({ title, children, actions, headingLevel, onSubmit, error }: FormLayoutProps) {
  const alertRef = useRef<HTMLDivElement>(null)
  const [submitError, setSubmitError] = useState<string | undefined>(undefined)
  const [focusTick, setFocusTick] = useState(0)
  const shown = error ?? submitError

  // Focus follows a new failure: a failed submit bumps the tick; a page-supplied error that appears does too.
  const lastTick = useRef(0)
  const lastError = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const newTick = focusTick !== lastTick.current
    const newError = error !== undefined && error !== lastError.current
    lastTick.current = focusTick
    lastError.current = error
    if ((newTick || newError) && shown) alertRef.current?.focus()
  })

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const result = await onSubmit()
    if (typeof result === 'string' && result) {
      setSubmitError(result)
      setFocusTick((t) => t + 1)
    } else {
      setSubmitError(undefined)
    }
  }

  return (
    <form noValidate onSubmit={submit}>
      <Card title={title} headingLevel={headingLevel} actions={actions}>
        {shown ? (
          <Alert variant="error" ref={alertRef}>
            {shown}
          </Alert>
        ) : null}
        {children}
      </Card>
    </form>
  )
}
