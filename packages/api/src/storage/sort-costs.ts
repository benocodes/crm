// [[CORE170]] D7, D12 and [[CORE175]] D12, D15: the two checked-in lists of the registry sort contract. Plain data in package source, so the
// contract test checks them and [[CORE187]]'s discovery can derive `indexed` from them at runtime (a sort is indexed unless it is listed here).

/** A list x sort whose `order=desc` D1 plan carries `USE TEMP B-TREE FOR ORDER BY`, accepted with a reason. Exact: the contract fails on a missing, obsolete or unknown entry. */
export interface StatedSortCost { readonly list: string; readonly sort: string; readonly reason: string }
/** A hand-written registry list that keeps ascending `id` and UUID cursors, with the reason it is outside the rollout (D15, #188); [[CORE188]] adopted action_executions, so two remain. */
export interface SortExemption { readonly list: string; readonly reason: string }

const COLUMN = 'no (organization_id, column, id) index (D7): a temporary sort over the organisation\'s live rows'
const DERIVED = 'derived field: evaluated per row by a correlated lookup of another table, then sorted in a temporary b-tree'
const ID = 'the planner reads the live-row unique index, whose order is not id, so id order needs a temporary sort, as the unsorted ascending list already does'

// [[CORE188]] D5: action_executions is read through `operation IN (the readable operations)`, so the planner searches the (organization_id, operation)
// index once per operation and every order, `id` included, is a temporary sort over the organisation's executions of those operations.
const EXECUTION_COLUMN = 'no (organization_id, column, id) index (D5): a temporary sort over the executions of the readable operations, a few hundred to a few thousand rows per workspace'
const EXECUTION_ID = 'the visibility predicate is operation IN (the readable operations): the planner searches the (organization_id, operation) index per operation, so id order needs a temporary sort, as the unsorted ascending list already does'

export const STATED_SORT_COSTS: readonly StatedSortCost[] = [
  { list: 'action_executions', sort: 'created_at', reason: EXECUTION_COLUMN },
  { list: 'action_executions', sort: 'done_at', reason: EXECUTION_COLUMN },
  { list: 'action_executions', sort: 'id', reason: EXECUTION_ID },
  { list: 'action_executions', sort: 'updated_at', reason: EXECUTION_COLUMN },
  { list: 'action_requests', sort: 'created_at', reason: COLUMN },
  { list: 'action_requests', sort: 'decided_at', reason: COLUMN },
  { list: 'action_requests', sort: 'expires_at', reason: COLUMN },
  { list: 'action_requests', sort: 'updated_at', reason: COLUMN },
  { list: 'agents', sort: 'created_at', reason: COLUMN },
  { list: 'agents', sort: 'name', reason: COLUMN },
  { list: 'agents', sort: 'updated_at', reason: COLUMN },
  { list: 'api_keys', sort: 'created_at', reason: COLUMN },
  { list: 'api_keys', sort: 'expires_at', reason: COLUMN },
  { list: 'api_keys', sort: 'last_used_at', reason: COLUMN },
  { list: 'api_keys', sort: 'updated_at', reason: COLUMN },
  { list: 'companies', sort: 'created_at', reason: COLUMN },
  { list: 'companies', sort: 'name', reason: COLUMN },
  { list: 'companies', sort: 'updated_at', reason: COLUMN },
  { list: 'company_files', sort: 'created_at', reason: COLUMN },
  { list: 'company_files', sort: 'updated_at', reason: COLUMN },
  { list: 'connections', sort: 'created_at', reason: COLUMN },
  { list: 'connections', sort: 'updated_at', reason: COLUMN },
  { list: 'contact_files', sort: 'created_at', reason: COLUMN },
  { list: 'contact_files', sort: 'updated_at', reason: COLUMN },
  { list: 'contacts', sort: 'created_at', reason: COLUMN },
  { list: 'contacts', sort: 'name', reason: COLUMN },
  { list: 'contacts', sort: 'updated_at', reason: COLUMN },
  { list: 'deals', sort: 'created_at', reason: COLUMN },
  { list: 'deals', sort: 'name', reason: COLUMN },
  { list: 'deals', sort: 'updated_at', reason: COLUMN },
  { list: 'files', sort: 'created_at', reason: COLUMN },
  { list: 'files', sort: 'name', reason: COLUMN },
  { list: 'identities', sort: 'created_at', reason: COLUMN },
  { list: 'identities', sort: 'updated_at', reason: COLUMN },
  { list: 'identities', sort: 'value', reason: COLUMN },
  { list: 'interactions', sort: 'created_at', reason: COLUMN },
  { list: 'memberships', sort: 'created_at', reason: COLUMN },
  { list: 'memberships', sort: 'updated_at', reason: COLUMN },
  { list: 'messages', sort: 'created_at', reason: COLUMN },
  { list: 'notes', sort: 'created_at', reason: COLUMN },
  { list: 'notes', sort: 'title', reason: COLUMN },
  { list: 'notes', sort: 'updated_at', reason: COLUMN },
  { list: 'pipeline_stages', sort: 'created_at', reason: COLUMN },
  { list: 'pipeline_stages', sort: 'name', reason: COLUMN },
  { list: 'pipeline_stages', sort: 'position', reason: COLUMN },
  { list: 'pipeline_stages', sort: 'updated_at', reason: COLUMN },
  { list: 'pipelines', sort: 'created_at', reason: COLUMN },
  { list: 'pipelines', sort: 'name', reason: COLUMN },
  { list: 'pipelines', sort: 'updated_at', reason: COLUMN },
  { list: 'tags', sort: 'created_at', reason: COLUMN },
  { list: 'tags', sort: 'name', reason: COLUMN },
  { list: 'tags', sort: 'updated_at', reason: COLUMN },
  { list: 'tasks', sort: 'created_at', reason: COLUMN },
  { list: 'tasks', sort: 'due_at', reason: COLUMN },
  { list: 'tasks', sort: 'title', reason: COLUMN },
  { list: 'tasks', sort: 'updated_at', reason: COLUMN },
  { list: 'threads', sort: 'created_at', reason: COLUMN },
  { list: 'threads', sort: 'subject', reason: COLUMN },
  { list: 'connections', sort: 'last_synced_at', reason: DERIVED },
  { list: 'contacts', sort: 'last_contacted_at', reason: DERIVED },
  { list: 'contacts', sort: 'last_interacted_at', reason: DERIVED },
  { list: 'company_files', sort: 'id', reason: ID },
  { list: 'contact_files', sort: 'id', reason: ID },
  { list: 'memberships', sort: 'id', reason: ID },
]

const HAND_WRITTEN = 'a hand-written list with its own query: it keeps ascending id and UUID cursors until #188 adopts the shared foundation on it'
export const SORT_EXEMPT_LISTS: readonly SortExemption[] = [
  { list: 'associations', reason: `${HAND_WRITTEN}; oriented edges of an anchor, paged by association id` },
  { list: 'users', reason: `${HAND_WRITTEN}; users with a live membership` },
  { list: 'events', reason: 'the change feed (API214): paged by event id in commit order (seq), never sorted; its cursor is the id of the last event seen and it has no column filters (API6 D2, D5)' },
  { list: 'webhooks', reason: 'owner-scoped subscriptions (API7 D22): a hand-written list paged by subscription id, ascending; no definition generates it' },
]
