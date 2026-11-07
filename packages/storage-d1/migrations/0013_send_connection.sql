-- AGT166 D66: preserve existing executions while adding their nullable sending-connection FK.
PRAGMA defer_foreign_keys = on;

CREATE TABLE action_executions_new (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  authorised_by TEXT NOT NULL REFERENCES principals (id),
  action_request_id TEXT,
  connection_id TEXT,
  operation TEXT NOT NULL CONSTRAINT action_executions_operation CHECK (length(operation) BETWEEN 3 AND 100),
  arguments TEXT NOT NULL CONSTRAINT action_executions_arguments CHECK (json_valid(arguments) AND json_type(arguments) = 'object'),
  resolution TEXT NOT NULL CONSTRAINT action_executions_resolution CHECK (json_valid(resolution) AND json_type(resolution) = 'object'),
  status TEXT NOT NULL CONSTRAINT action_executions_status CHECK (status IN ('queued', 'claimed', 'done', 'failed')),
  client_ref TEXT NOT NULL CONSTRAINT action_executions_client_ref CHECK (length(client_ref) BETWEEN 3 AND 300),
  idempotency_key TEXT CONSTRAINT action_executions_idempotency_key CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  deadline_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deadline_at) = deadline_at, 0)),
  dispatched_at TEXT CHECK (dispatched_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', dispatched_at) = dispatched_at, 0)),
  done_at TEXT CHECK (done_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', done_at) = done_at, 0)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) = next_attempt_at, 0)),
  lease_until TEXT CHECK (lease_until IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', lease_until) = lease_until, 0)),
  lease_token TEXT,
  last_error_code TEXT,
  result TEXT CONSTRAINT action_executions_result CHECK (result IS NULL OR json_valid(result)),
  error_code TEXT,
  error_message TEXT CONSTRAINT action_executions_error_message CHECK (error_message IS NULL OR length(error_message) <= 2000),
  CONSTRAINT action_executions_done CHECK (status <> 'done' OR result IS NOT NULL),
  CONSTRAINT action_executions_failed CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CONSTRAINT action_executions_finished CHECK ((status IN ('done', 'failed')) = (done_at IS NOT NULL)),
  CONSTRAINT action_executions_outcome CHECK ((status <> 'done' OR error_code IS NULL) AND (status <> 'failed' OR result IS NULL)),
  CONSTRAINT action_executions_lease CHECK ((status = 'claimed' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status <> 'claimed' AND lease_token IS NULL AND lease_until IS NULL)),
  CONSTRAINT action_executions_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id),
  CONSTRAINT action_executions_request_fk FOREIGN KEY (organization_id, action_request_id) REFERENCES action_requests (organization_id, id)
) STRICT;

INSERT INTO action_executions_new (id, created_at, updated_at, organization_id, created_by, authorised_by, action_request_id, operation, arguments, resolution, status, client_ref, idempotency_key, input_hash, deadline_at, dispatched_at, done_at, attempts, next_attempt_at, lease_until, lease_token, last_error_code, result, error_code, error_message)
SELECT id, created_at, updated_at, organization_id, created_by, authorised_by, action_request_id, operation, arguments, resolution, status, client_ref, idempotency_key, input_hash, deadline_at, dispatched_at, done_at, attempts, next_attempt_at, lease_until, lease_token, last_error_code, result, error_code, error_message FROM action_executions;
DROP TABLE action_executions;
ALTER TABLE action_executions_new RENAME TO action_executions;

-- D59: an approved request has at most one execution; a direct caller's key is unique per (organisation, creator) (D51); `client_ref` is unique.
CREATE UNIQUE INDEX idx_action_executions_request ON action_executions (organization_id, action_request_id) WHERE action_request_id IS NOT NULL;
CREATE UNIQUE INDEX idx_action_executions_idempotency ON action_executions (organization_id, created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_action_executions_client_ref ON action_executions (client_ref);
-- The runner sweep (D54): queued executions by when they are due, and claimed ones by when their lease lapses.
CREATE INDEX idx_action_executions_due ON action_executions (next_attempt_at, id) WHERE status = 'queued';
CREATE INDEX idx_action_executions_lease ON action_executions (lease_until, id) WHERE status = 'claimed';
-- The reads (D57): the list filters.
CREATE INDEX idx_action_executions_organization_status ON action_executions (organization_id, status, id);
CREATE INDEX idx_action_executions_organization_operation ON action_executions (organization_id, operation, id);
