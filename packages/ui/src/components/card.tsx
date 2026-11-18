// The Card composite ([[UI254]] D6): a region named by its heading, a body and an actions row.
import type { ReactNode } from 'react'
import { useId } from 'react'
import { Card as CardPrimitive, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card'

export interface CardProps {
  title: string
  children: ReactNode
  /** The actions region (buttons), below the body. */
  actions?: ReactNode
  headingLevel?: 1 | 2 | 3
}

export function Card({ title, children, actions, headingLevel = 1 }: CardProps) {
  const headingId = useId()
  const Heading = `h${headingLevel}` as const
  return (
    <CardPrimitive asChild>
      <section aria-labelledby={headingId}>
        <CardHeader>
          <CardTitle asChild>
            <Heading id={headingId} className="text-xl">
              {title}
            </Heading>
          </CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
        {actions ? <CardFooter>{actions}</CardFooter> : null}
      </section>
    </CardPrimitive>
  )
}
