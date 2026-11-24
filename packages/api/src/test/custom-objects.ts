// Test-only. The custom object the CORE315 suites declare, and the way a test gives it its table on a local D1.
import type { D1Like } from '@vibase/storage-d1'
import type { ObjectDeclaration } from '../custom/declaration.js'
import { createTableStatements } from '../custom/ddl.js'
import { defineCustomObject } from '../custom/resource.js'

export const PROJECTS_KEY = 'projects__c'
/** One field of each kind: required text, optional integer, a defaulted boolean, a timestamp and a defaulted enum. */
export const PROJECTS: ObjectDeclaration = {
  label: 'Projects',
  description: 'A piece of client work',
  fields: {
    name: { kind: 'text', label: 'Name', required: true },
    budget: { kind: 'integer', label: 'Budget' },
    active: { kind: 'boolean', default: true },
    start_date: { kind: 'timestamp' },
    stage: { kind: 'enum', values: ['planned', 'active', 'done'], default: 'planned' },
  },
}
export const projectsDefinition = () => defineCustomObject(PROJECTS_KEY, PROJECTS)

/** Creates the table (and its index) on a migrated D1: what T3's apply will do. */
export async function createCustomTables(d1: D1Like, key = PROJECTS_KEY, declaration = PROJECTS): Promise<void> {
  await d1.batch(createTableStatements(key, declaration).map((s) => d1.prepare(s)))
}

/**
 * [[CORE541]]: the same object with a reference to each allowed target (principals, companies, deals, tasks and itself) and two unique fields. `projects__c` again, in the suites that need references: each suite has its own D1.
 */
export const PROJECTS_REFS: ObjectDeclaration = {
  ...PROJECTS,
  fields: {
    ...PROJECTS.fields,
    owner: { kind: 'reference', target: 'principals' },
    company: { kind: 'reference', target: 'companies' },
    deal: { kind: 'reference', target: 'deals' },
    task: { kind: 'reference', target: 'tasks' },
    parent: { kind: 'reference', target: PROJECTS_KEY },
    code: { kind: 'text', unique: true },
    seq: { kind: 'integer', unique: true },
  },
}
export const projectsRefsDefinition = () => defineCustomObject(PROJECTS_KEY, PROJECTS_REFS)
