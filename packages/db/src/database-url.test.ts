import { describe, expect, it } from 'vitest'
import { assertTestDatabaseName, withUser, worktreeDatabaseName } from './database-url.js'

describe('assertTestDatabaseName', () => {
  it('accepts a test DB', () => {
    expect(assertTestDatabaseName('postgresql://localhost/vault_test')).toBe('vault_test')
  })
  it('accepts a worktree DB', () => {
    expect(assertTestDatabaseName('postgresql://localhost/vault_test_core1')).toBe('vault_test_core1')
  })
  it('refuses dev', () => {
    expect(() => assertTestDatabaseName('postgresql://localhost/vault_dev')).toThrow(
      'refusing: database "vault_dev" is not a test database',
    )
  })
  it('refuses substring match', () => {
    expect(() => assertTestDatabaseName('postgresql://localhost/contest')).toThrow()
  })
  it('refuses missing name', () => {
    expect(() => assertTestDatabaseName('postgresql://localhost/')).toThrow(
      'refusing: no database name in postgresql://localhost/',
    )
  })
  it('does not echo passwords', () => {
    let message = ''
    try {
      assertTestDatabaseName('postgresql://u:secret@localhost/')
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('refusing')
    expect(message).not.toContain('secret')
  })
})

describe('worktreeDatabaseName', () => {
  it('names from the folder', () => {
    expect(worktreeDatabaseName('/a/b/.claude/worktrees/core1')).toBe('vault_test_core1')
  })
  it('folds punctuation and case', () => {
    expect(worktreeDatabaseName('/x/My--Cycle.2')).toBe('vault_test_my_cycle_2')
  })
  it('trims underscores', () => {
    expect(worktreeDatabaseName('/x/-core1-')).toBe('vault_test_core1')
  })
})

describe('withUser', () => {
  it('swaps user', () => {
    expect(withUser('postgresql://ori@localhost:5432/vault_test', 'vault_app')).toBe(
      'postgresql://vault_app@localhost:5432/vault_test',
    )
  })
  it('adds user when absent', () => {
    expect(withUser('postgresql://localhost/vault_test', 'vault_app')).toBe(
      'postgresql://vault_app@localhost/vault_test',
    )
  })
  it('drops password', () => {
    expect(withUser('postgresql://ori:pw@localhost/vault_test', 'vault_app')).not.toContain('pw')
  })
})
