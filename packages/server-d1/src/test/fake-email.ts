// Test support ([[CORE248]] D8): a fake `EMAIL` binding that records the message objects it receives and can be told to reject. No real send, and Miniflare's own `send_email` simulation is not used.
export interface FakeEmail {
  readonly sent: Array<Record<string, any>>
  /** While true, `send` rejects (and records nothing). */
  failing: boolean
  send(message: unknown): Promise<unknown>
}
export function fakeEmail(): FakeEmail {
  const fake: FakeEmail = {
    sent: [],
    failing: false,
    async send(message) {
      if (fake.failing) throw new Error('simulated provider failure')
      fake.sent.push(message as Record<string, any>)
      return { messageId: `m${fake.sent.length}` }
    },
  }
  return fake
}
