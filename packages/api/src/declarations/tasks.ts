import { z } from 'zod'
import { BOOKKEEPING_FIELDS, IDENTITY_FIELDS, type BuiltInDeclaration } from './builtin.js'

/** The statuses of a task: the field's values and the status filter's operand. */
export const TASK_STATUSES = ['open', 'done'] as const

/** Tasks ([[CORE554]]): something to do. The completion rule (`completed_at` follows `status`) stays code in `resources/tasks.ts`. */
export const tasksDeclaration = {
  table: 'tasks',
  label: 'Tasks',
  description: 'Something to do, optionally assigned and with a due date. Completion is derived from status.',
  fields: {
    ...IDENTITY_FIELDS,
    title: {
      kind: 'text',
      required: true,
      trim: true,
      minLength: 1,
      maxLength: 500,
      description: 'What needs doing.',
    },
    description: {
      kind: 'text',
      nullable: true,
      maxLength: 10_000,
      description: "The task's own description. Research and context belong in associated notes.",
    },
    status: {
      kind: 'enum',
      values: [...TASK_STATUSES],
      description: 'open or done. Setting done stamps completed_at; setting open clears it.',
      filter: { schema: z.enum(TASK_STATUSES) },
    },
    due_at: { kind: 'timestamp', nullable: true, description: 'When the task is due.' },
    completed_at: {
      kind: 'timestamp',
      nullable: true,
      input: 'system',
      description: 'When the task was marked done; null while open.',
    },
    assignee_id: {
      kind: 'reference',
      target: 'principals',
      nullable: true,
      description: 'The principal responsible for the task, if any.',
      filter: { schema: z.uuid() },
    },
    ...BOOKKEEPING_FIELDS,
  },
  sorts: ['due_at', 'title'],
} satisfies BuiltInDeclaration<'tasks'>
