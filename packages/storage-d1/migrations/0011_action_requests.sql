-- AGT8 cycle 1 (D3, D4, D5, D19, D20, D23, D35, D37; D1 only): action requests. An action request names a registered operation and its
-- arguments for review; an authorised principal approves it (the operation then runs inline as the approver, in the same unit as the
-- decision), rejects it, or its source withdraws it. `arguments` is the original proposal and never changes; an approval may carry complete
-- `edited_arguments`. `decided_by` is a principal, not a user: a reviewer may be an agent. Only `pending` has no decision. One pending request
-- per (organisation, dedup_key). No `action_executions` and no approval rules here: the asynchronous rail is the next cycle (#165).
-- `superseded_by_id` is filled by a second statement after the superseding row exists (SQLite checks the key at statement end), so it is not
-- required by a CHECK. `contact_id`, `thread_id` and `interaction_id` are context, never execution inputs (D20).

CREATE TABLE action_requests (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  operation TEXT NOT NULL CONSTRAINT action_requests_operation CHECK (length(operation) BETWEEN 3 AND 100),
  arguments TEXT NOT NULL CONSTRAINT action_requests_arguments CHECK (json_valid(arguments) AND json_type(arguments) = 'object'),
  edited_arguments TEXT CONSTRAINT action_requests_edited_arguments CHECK (edited_arguments IS NULL OR (json_valid(edited_arguments) AND json_type(edited_arguments) = 'object')),
  status TEXT NOT NULL CONSTRAINT action_requests_status CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired', 'superseded', 'executed', 'failed')),
  reason TEXT NOT NULL CONSTRAINT action_requests_reason CHECK (length(reason) BETWEEN 1 AND 2000),
  evidence TEXT NOT NULL CONSTRAINT action_requests_evidence CHECK (json_valid(evidence) AND json_type(evidence) = 'array' AND json_array_length(evidence) <= 20),
  contact_id TEXT,
  thread_id TEXT,
  interaction_id TEXT,
  dedup_key TEXT CONSTRAINT action_requests_dedup_key CHECK (dedup_key IS NULL OR length(dedup_key) BETWEEN 1 AND 200),
  expires_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at, 0)),
  decided_by TEXT REFERENCES principals (id),
  decided_at TEXT CHECK (decided_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) = decided_at, 0)),
  decision_reason TEXT CONSTRAINT action_requests_decision_reason CHECK (decision_reason IS NULL OR length(decision_reason) <= 2000),
  superseded_by_id TEXT,
  result TEXT CONSTRAINT action_requests_result CHECK (result IS NULL OR json_valid(result)),
  error_code TEXT,
  error_message TEXT,
  executed_at TEXT CHECK (executed_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', executed_at) = executed_at, 0)),
  CONSTRAINT action_requests_decided CHECK ((status = 'pending') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT action_requests_executed CHECK ((status = 'executed') = (executed_at IS NOT NULL)),
  UNIQUE (organization_id, id),
  CONSTRAINT action_requests_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts (organization_id, id),
  CONSTRAINT action_requests_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
  CONSTRAINT action_requests_interaction_fk FOREIGN KEY (organization_id, interaction_id) REFERENCES interactions (organization_id, id),
  CONSTRAINT action_requests_superseded_by_fk FOREIGN KEY (organization_id, superseded_by_id) REFERENCES action_requests (organization_id, id)
) STRICT;

-- D5: one pending request per dedup key in an organisation; the backstop of the plan read and the commit guard.
CREATE UNIQUE INDEX idx_action_requests_pending_dedup ON action_requests (organization_id, dedup_key) WHERE status = 'pending' AND dedup_key IS NOT NULL;
-- D37 and the expiry sweep (#165): the pending requests by expiry.
CREATE INDEX idx_action_requests_pending_expiry ON action_requests (expires_at) WHERE status = 'pending';
CREATE INDEX idx_action_requests_organization_status ON action_requests (organization_id, status, id);
CREATE INDEX idx_action_requests_organization_created_by ON action_requests (organization_id, created_by);
CREATE INDEX idx_action_requests_organization_operation ON action_requests (organization_id, operation);
CREATE INDEX idx_action_requests_contact ON action_requests (organization_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_action_requests_thread ON action_requests (organization_id, thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX idx_action_requests_interaction ON action_requests (organization_id, interaction_id) WHERE interaction_id IS NOT NULL;
