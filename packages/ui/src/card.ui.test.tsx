import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, userEvent, waitFor } from '#render'
import { Button } from './button'
import { Card, FormLayout } from './card'
import { Field } from './field'

describe('Card', () => {
  it('is a region named by its heading, with body and actions', () => {
    render(
      <Card title="Sign in" actions={<Button>Go</Button>}>
        <p>Body</p>
      </Card>,
    )
    const region = screen.getByRole('region', { name: 'Sign in' })
    expect(region.querySelector('h1')?.textContent).toBe('Sign in')
    expect(region.textContent).toContain('Body')
    expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy()
  })
})

function Form(props: { onSubmit: () => string | null | void | Promise<string | null | void>; error?: string }) {
  const [email, setEmail] = useState('')
  return (
    <FormLayout title="Sign in" onSubmit={props.onSubmit} error={props.error} actions={<Button type="submit">Continue</Button>}>
      <Field label="Email" value={email} onChange={setEmail} />
    </FormLayout>
  )
}

describe('FormLayout', () => {
  it('is a <form novalidate>', () => {
    const { container } = render(<Form onSubmit={() => {}} />)
    const form = container.querySelector('form')!
    expect(form).toBeTruthy()
    expect(form.noValidate).toBe(true)
  })

  it('Enter in a field submits (keyboard only)', async () => {
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'a@b.co{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('a failed validation shows the message in an error Alert and moves focus there', async () => {
    render(<Form onSubmit={() => 'Enter your email'} />)
    const user = userEvent.setup()
    await user.click(screen.getByLabelText('Email'))
    await user.keyboard('{Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Enter your email')
    await waitFor(() => expect(document.activeElement).toBe(alert))
  })

  it('a successful submit shows no alert and leaves focus alone', async () => {
    render(<Form onSubmit={() => {}} />)
    const user = userEvent.setup()
    const input = screen.getByLabelText('Email')
    await user.click(input)
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(input)
  })

  it('a later successful submit clears the alert', async () => {
    let fail = true
    render(<Form onSubmit={() => (fail ? 'Bad' : undefined)} />)
    const user = userEvent.setup()
    await user.click(screen.getByLabelText('Email'))
    await user.keyboard('{Enter}')
    await screen.findByRole('alert')
    fail = false
    await user.click(screen.getByLabelText('Email'))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('an error the page sets shows in the Alert and takes focus when it appears', async () => {
    const { rerender } = render(<Form onSubmit={() => {}} />)
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<Form onSubmit={() => {}} error="Wrong password" />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Wrong password')
    await waitFor(() => expect(document.activeElement).toBe(alert))
  })
})
