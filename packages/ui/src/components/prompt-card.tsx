// The PromptCard composite ([[UI443]] D11): a title, a text, one primary action that is a link or a button, and an optional body.
import type { ReactNode } from 'react'
import { useId } from 'react'
import { Button } from './ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card'

export type PromptAction = { label: string; href: string } | { label: string; onClick: () => void }

export interface PromptCardProps {
  title: string
  text: string
  action: PromptAction
  /** The `<h*>` level of the title; 3 by default, for a card under a section's `<h2>`. */
  headingLevel?: 2 | 3 | 4
  /** The optional body, under the text and above the action. */
  children?: ReactNode
}

export function PromptCard({ title, text, action, headingLevel = 3, children }: PromptCardProps) {
  const headingId = useId()
  const Heading = `h${headingLevel}` as const
  return (
    <Card asChild>
      <section aria-labelledby={headingId}>
        <CardHeader>
          <CardTitle asChild>
            <Heading id={headingId} className="text-base">
              {title}
            </Heading>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{text}</p>
        </CardHeader>
        {children ? <CardContent>{children}</CardContent> : null}
        <CardFooter>
          {'href' in action ? (
            <Button asChild>
              <a href={action.href}>{action.label}</a>
            </Button>
          ) : (
            <Button type="button" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </CardFooter>
      </section>
    </Card>
  )
}
