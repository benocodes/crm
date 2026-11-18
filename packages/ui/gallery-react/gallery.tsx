// The React gallery ([[UI445]] D9, [[UI448]] P5): every D7 component in every state, rendered with the real components. Page code: only the
// layout of this page is styled here; the components carry their own classes.
import { type ReactNode, useState } from 'react'
import { Alert, Button, Card, CodeInput, Field, FormLayout, ScopeList, ui } from '../src/components'

const SCOPES = [
  { name: 'contacts:read', description: 'Read contacts' },
  { name: 'contacts:write', description: 'Create and change contacts' },
  { name: 'deals:read', description: 'Read deals' },
  { name: 'deals:write', description: 'Create, change and move deals' },
  { name: 'messages:read', description: 'Read messages' },
  { name: 'messages:send', description: 'Send messages' },
  { name: '<img src=x onerror=alert(1)>', description: '<b>text, never markup</b>' },
]

function Section({ state, title, children }: { state: string; title: string; children: ReactNode }) {
  return (
    <section data-gallery-state={state} aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Fields() {
  const [filled, setFilled] = useState('ada@example.com')
  const [empty, setEmpty] = useState('')
  const [bad, setBad] = useState('nope')
  const [off, setOff] = useState('locked')
  return (
    <Section state="field" title="Field">
      <Field label="Email (empty)" type="email" autoComplete="email" value={empty} onChange={setEmpty} />
      <Field
        label="Email (filled)"
        type="email"
        autoComplete="email"
        value={filled}
        onChange={setFilled}
        hint="Work address"
      />
      <Field
        label="Email (error)"
        type="email"
        value={bad}
        onChange={setBad}
        hint="Work address"
        error="Enter a valid email address."
      />
      <Field label="Email (disabled)" value={off} onChange={setOff} disabled />
    </Section>
  )
}

function Codes() {
  const [empty, setEmpty] = useState('')
  const [filled, setFilled] = useState('ABCD-EFGH')
  const [bad, setBad] = useState('WXYZ-1234')
  return (
    <Section state="code-input" title="CodeInput">
      <CodeInput label="Code (empty)" value={empty} onChange={setEmpty} />
      <CodeInput label="Code (filled)" value={filled} onChange={setFilled} />
      <CodeInput label="Code (error)" value={bad} onChange={setBad} error="That code is not recognised." />
      <CodeInput label="Code (disabled)" value="ABCD-EFGH" onChange={() => {}} disabled />
    </Section>
  )
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [done, setDone] = useState(false)
  return (
    <Section state="form-layout" title="FormLayout">
      <FormLayout
        title="Sign in"
        headingLevel={3}
        onSubmit={() => {
          if (!email) return 'Enter your email address.'
          setDone(true)
        }}
        actions={
          <Button type="submit" block>
            Continue
          </Button>
        }
      >
        {done ? <Alert variant="success">Signed in as {email}.</Alert> : null}
        <Field label="Your email" type="email" autoComplete="email" value={email} onChange={setEmail} />
      </FormLayout>
    </Section>
  )
}

export function Gallery() {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-semibold">Vibase UI gallery</h1>
      <p className="text-muted-foreground">React, Tailwind and the neutral theme under the pages' CSP.</p>
      <Section state="buttons" title="Button">
        <div className="flex flex-wrap gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button busy>Busy</Button>
          <Button disabled>Disabled</Button>
        </div>
        <Button block>Block</Button>
      </Section>
      <Section state="input-label" title="Input and Label">
        <div className="flex flex-col gap-2">
          <ui.Label htmlFor="gallery-plain">Plain label</ui.Label>
          <ui.Input id="gallery-plain" placeholder="Placeholder" />
        </div>
      </Section>
      <Fields />
      <Codes />
      <Section state="alert" title="Alert">
        <Alert>Information.</Alert>
        <Alert variant="success">Saved.</Alert>
        <Alert variant="error">Something went wrong.</Alert>
      </Section>
      <Section state="card" title="Card">
        <Card title="Authorise Claude" headingLevel={3} actions={<Button variant="secondary">Cancel</Button>}>
          <p className="text-sm">Claude asks for these permissions.</p>
        </Card>
      </Section>
      <Section state="scope-list" title="ScopeList">
        <ScopeList scopes={SCOPES} />
      </Section>
      <SignIn />
    </div>
  )
}
