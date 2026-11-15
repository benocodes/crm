// The Better Auth half of verify and of the closing output, shared by both setup front-ends ([[OPS306]], [[OPS249]] D4, D5, D8). Pure but for the injected `fetch`, clock and `sleep`:
// no subprocess, no file. The expected issuer comes from the recorded PUBLIC_BASE_URL (`https://<api host>`), never from a request host ([[CORE243]] D23).

/** [[OPS249]] D5, P3: the statement both front-ends print on `better-auth` without email, and that the docs quote. [[CORE243]] D16's text without its owner sentence ([[OPS307]] adds that). */
export const NO_EMAIL_STATEMENT =
  'Email is not configured: there is no self-service password reset. A member who forgets their password gets a reset link from an owner. Invitation links are printed for you to send.'

export const DISCOVERY_BOUND_MS = 300_000
export const DISCOVERY_INTERVAL_MS = 10_000
export interface DiscoveryReads { fetch: typeof fetch; now(): number; sleep(ms: number): Promise<void>; dryRun: boolean }
export type IssuerCheck = { ok: true; signInMethods: string[] } | { ok: false; detail: string }
// Red-commit stub: the behaviour arrives in the green commit.
export async function checkBetterAuthIssuer(_base: string, _r: DiscoveryReads): Promise<IssuerCheck> { return { ok: true, signInMethods: [] } }
export function emailConfigured(_block: { send_email?: unknown; vars?: Record<string, unknown> } | undefined): boolean { return true }
export interface NextStepsInput { url: string; claimLink: boolean; google: boolean; emailConfigured: boolean; hint: string[] }
export function betterAuthNextSteps(i: NextStepsInput): string[] { return [`API: ${i.url}`, ...i.hint] }
