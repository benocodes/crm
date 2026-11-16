import { describe, expect, it } from 'vitest'
import { authOptions } from './auth.js'

// [[UI255]] D3 (group 2, option level): `trustedOrigins` is `[baseURL]` exactly when no extra origin is configured ([[CORE243]] D23 unchanged), else the extras follow `baseURL`.
const db = { prepare: () => ({}) }
const config = { secret: 'a-valid-auth-secret-of-exactly-32!', baseURL: 'https://api.example.com' }

describe('trustedOrigins', () => {
  it('with no extra origin it is exactly [baseURL]', () => {
    expect(authOptions(db, config).trustedOrigins).toEqual(['https://api.example.com'])
    expect(authOptions(db, { ...config, trustedOrigins: [] }).trustedOrigins).toEqual(['https://api.example.com'])
  })
  it('extra origins are appended after baseURL, in order', () => {
    expect(
      authOptions(db, { ...config, trustedOrigins: ['https://app.example.com', 'http://localhost:8788'] })
        .trustedOrigins,
    ).toEqual(['https://api.example.com', 'https://app.example.com', 'http://localhost:8788'])
  })
})
