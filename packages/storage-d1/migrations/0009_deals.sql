-- CORE130: deals and pipelines (D1 only, D2, D3, D6, D7, D9, D19). A pipeline is a named sales process, a stage one step of it
-- (`kind` open | won | lost, `position` its place in the order, not unique), a deal a potential sale in exactly one stage.
-- Names compare case-insensitively through their NOCASE collation (ASCII folding) and are unique among live rows: pipelines per
-- organisation, stages per pipeline. A deal's `pipeline_id` is its stage's: the composite foreign key makes a disagreement impossible.
-- Nothing is seeded (D5). A deal's status is not stored (D8): it is the kind of its stage.

CREATE TABLE pipelines (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CONSTRAINT pipelines_name_length CHECK (length(name) BETWEEN 1 AND 100),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))
) STRICT;

CREATE INDEX idx_pipelines_organization_id_id ON pipelines (organization_id, id);
CREATE UNIQUE INDEX idx_pipelines_live_name ON pipelines (organization_id, name) WHERE deleted_at IS NULL;

CREATE TABLE pipeline_stages (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pipeline_id TEXT NOT NULL REFERENCES pipelines (id),
  name TEXT NOT NULL COLLATE NOCASE CONSTRAINT pipeline_stages_name_length CHECK (length(name) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CONSTRAINT pipeline_stages_kind CHECK (kind IN ('open', 'won', 'lost')),
  position INTEGER NOT NULL CONSTRAINT pipeline_stages_position CHECK (position >= 0),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))
) STRICT;

CREATE INDEX idx_pipeline_stages_organization_id_id ON pipeline_stages (organization_id, id);
-- The target of the deals composite foreign key.
CREATE UNIQUE INDEX idx_pipeline_stages_pipeline_id_id ON pipeline_stages (pipeline_id, id);
CREATE UNIQUE INDEX idx_pipeline_stages_live_name ON pipeline_stages (organization_id, pipeline_id, name) WHERE deleted_at IS NULL;

CREATE TABLE deals (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name TEXT NOT NULL CONSTRAINT deals_name_length CHECK (length(name) BETWEEN 1 AND 200),
  pipeline_id TEXT NOT NULL REFERENCES pipelines (id),
  stage_id TEXT NOT NULL,
  amount_minor INTEGER CONSTRAINT deals_amount_minor CHECK (amount_minor IS NULL OR (amount_minor >= 0 AND amount_minor <= 9007199254740991)),
  currency TEXT CONSTRAINT deals_currency CHECK (currency IS NULL OR (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*')),
  expected_close_date TEXT CONSTRAINT deals_expected_close_date CHECK (expected_close_date IS NULL OR date(expected_close_date) = expected_close_date),
  owner_id TEXT REFERENCES principals (id),
  closed_at TEXT CHECK (closed_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) = closed_at, 0)),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  CONSTRAINT deals_amount_needs_currency CHECK (amount_minor IS NULL OR currency IS NOT NULL),
  CONSTRAINT deals_stage_fk FOREIGN KEY (pipeline_id, stage_id) REFERENCES pipeline_stages (pipeline_id, id)
) STRICT;

CREATE INDEX idx_deals_organization_id_id ON deals (organization_id, id);
CREATE INDEX idx_deals_organization_id_pipeline_id ON deals (organization_id, pipeline_id);
CREATE INDEX idx_deals_organization_id_stage_id ON deals (organization_id, stage_id);
CREATE INDEX idx_deals_organization_id_owner_id ON deals (organization_id, owner_id);
