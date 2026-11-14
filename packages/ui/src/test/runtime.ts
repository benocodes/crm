import * as React from 'react'

/**
 * Which runtime `react` resolves to. `preact/compat` stamps `$$typeof` on its vnodes, so an element cannot tell them apart; the module
 * can: real React exports its client internals under this name, `preact/compat` does not.
 */
export function detectRuntime(): 'react' | 'preact' {
  return '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE' in React ? 'react' : 'preact'
}
