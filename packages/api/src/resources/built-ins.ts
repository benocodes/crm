// Stub (red commit): the composed built-ins arrive with the green commit.
import { companies } from './companies.js'
import { contacts } from './contacts.js'
import { deals } from './deals.js'
import { tasks } from './tasks.js'

export const createBuiltIns = (_extend?: unknown) => ({ contacts, companies, deals, tasks })
