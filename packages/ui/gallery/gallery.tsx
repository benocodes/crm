import { useState } from 'react'
import { Alert, Button, Card, CodeInput, Field, FormLayout, ScopeList } from '../src/index'

/** One component state, wrapped so the e2e run can screenshot it by `data-gallery-state`. */
function State({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div data-gallery-state={name}>
      <h2 className="vb-card__title">{name}</h2>
      {children}
    </div>
  )
}

function FieldState(props: { initial?: string; error?: string; hint?: string; disabled?: boolean; label: string; type?: 'email' | 'password' | 'text' }) {
  const [value, setValue] = useState(props.initial ?? '')
  return <Field label={props.label} type={props.type} value={value} onChange={setValue} error={props.error} hint={props.hint} disabled={props.disabled} />
}

function CodeState(props: { error?: string }) {
  const [value, setValue] = useState('')
  return <CodeInput label="Device code" value={value} onChange={setValue} error={props.error} />
}

function InvalidForm() {
  const [email, setEmail] = useState('')
  return (
    <FormLayout
      title="Sign in"
      headingLevel={2}
      onSubmit={() => (email.trim() ? undefined : 'Enter your email address.')}
      actions={<Button type="submit">Continue</Button>}
    >
      <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" hint="The address you were invited with." />
    </FormLayout>
  )
}

export function Gallery() {
  return (
    <>
      <h1 className="vb-card__title">Vibase UI gallery</h1>
      <State name="button">
        <div className="vb-card__actions">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button busy>Busy</Button>
          <Button disabled>Disabled</Button>
        </div>
      </State>
      <State name="field-empty">
        <FieldState label="Work email" type="email" hint="We never share it." />
      </State>
      <State name="field-filled">
        <FieldState label="Name" initial="Ada Lovelace" />
      </State>
      <State name="field-error">
        <FieldState label="Password" type="password" initial="x" error="Use at least 12 characters." hint="Longer is better." />
      </State>
      <State name="field-disabled">
        <FieldState label="Organisation" initial="Vibase" disabled />
      </State>
      <State name="alert">
        <div className="vb-card__body">
          <Alert variant="info">Your invitation is valid.</Alert>
          <Alert variant="success">Password updated.</Alert>
          <Alert variant="error">That link has expired.</Alert>
        </div>
      </State>
      <State name="card">
        <Card title="Authorise Example Agent" headingLevel={2} actions={<Button>Allow</Button>}>
          <p>This app is asking for access.</p>
        </Card>
      </State>
      <State name="scope-list">
        <Card title="Requested access" headingLevel={2}>
          <ScopeList
            scopes={[
              { name: 'contacts:read', description: 'Read contacts' },
              { name: 'notes:write', description: 'Create and edit notes' },
              { name: '<img src=x onerror=alert(1)>', description: 'Rendered as text, never as markup' },
            ]}
          />
        </Card>
      </State>
      <State name="code-input-empty">
        <CodeState />
      </State>
      <State name="code-input-error">
        <CodeState error="That code was not recognised." />
      </State>
      <State name="form-invalid">
        <InvalidForm />
      </State>
    </>
  )
}
