import { hashPassword as scryptHash } from 'better-auth/crypto'
import { describe, expect, it } from 'vitest'
import { hashPassword, PBKDF2_ITERATIONS, verifyPassword } from './index.js'

// [[CORE243]] D13, P3: the vault's password hasher. Stored hashes are self-describing, so a change of parameters or algorithm still verifies old ones.
describe('the password hasher', () => {
  it('writes a self-describing PBKDF2-SHA256 hash and verifies the right password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(new RegExp(`^pbkdf2-sha256\\$${PBKDF2_ITERATIONS}\\$[A-Za-z0-9_-]+\\$[A-Za-z0-9_-]+$`))
    expect(await verifyPassword({ hash, password: 'correct horse battery staple' })).toBe(true)
  })

  it('refuses a wrong password, and salts every hash', async () => {
    const a = await hashPassword('one password')
    const b = await hashPassword('one password')
    expect(a).not.toBe(b)
    expect(await verifyPassword({ hash: a, password: 'another password' })).toBe(false)
  })

  it('verifies a hash made with other parameters, from the parameters it carries (not the current constant)', async () => {
    const old = await hashPassword('old parameters', { iterations: 1_000 })
    expect(old.split('$')[1]).toBe('1000')
    expect(await verifyPassword({ hash: old, password: 'old parameters' })).toBe(true)
    expect(await verifyPassword({ hash: old, password: 'old parameterz' })).toBe(false)
  })

  it("verifies a hash in Better Auth's own scrypt format (an account made under the library default)", async () => {
    const legacy = await scryptHash('library default')
    expect(await verifyPassword({ hash: legacy, password: 'library default' })).toBe(true)
    expect(await verifyPassword({ hash: legacy, password: 'library defaulT' })).toBe(false)
  })

  it.each([
    ['empty', ''],
    ['unknown algorithm', 'bcrypt$10$abc$def'],
    ['truncated', 'pbkdf2-sha256$100000$abc'],
    ['zero iterations', 'pbkdf2-sha256$0$abc$def'],
    ['not a number', 'pbkdf2-sha256$many$abc$def'],
  ])('a malformed hash (%s) is a refusal, not a throw', async (_n, hash) => {
    expect(await verifyPassword({ hash, password: 'x' })).toBe(false)
  })
})
