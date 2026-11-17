-- CHN420 cycle 1 (D1, D3, D6, D7, D8, D9, D10, D15): forms, the workspace configuration a website posts to. A form is its own table, not a channel connection (D1).
-- `forms.id` references `agents (id)`: the form's principal is an agents row sharing its id, created in the same unit (D3), so `principals` is not rebuilt.
-- The public id is minted by the vault: `frm_` plus 26 lowercase Crockford base32 characters (0-9 and a-z without i, l, o, u), unique over deleted rows too, so one is never reused (D6).
-- The field mapping is three typed columns, at least one identity field and no two equal (D7). The two child tables (allowed origins, tags) are created here and written by CHN424.
-- GLOB is case-sensitive; in a character class `]` first and `-` last are literal. The live-name index folds ASCII case only (NOCASE).

CREATE TABLE forms (
  id TEXT PRIMARY KEY NOT NULL REFERENCES agents (id)
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  name TEXT NOT NULL CONSTRAINT forms_name_length CHECK (length(name) BETWEEN 1 AND 200),
  public_id TEXT NOT NULL UNIQUE CONSTRAINT forms_public_id_shape CHECK (length(public_id) = 30 AND substr(public_id, 1, 4) = 'frm_' AND substr(public_id, 5) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'),
  enabled INTEGER NOT NULL DEFAULT 1 CONSTRAINT forms_enabled CHECK (enabled IN (0, 1)),
  email_field TEXT CONSTRAINT forms_email_field_shape CHECK (email_field IS NULL OR (length(email_field) BETWEEN 1 AND 64 AND email_field NOT GLOB '*[^]A-Za-z0-9_.[-]*')),
  phone_field TEXT CONSTRAINT forms_phone_field_shape CHECK (phone_field IS NULL OR (length(phone_field) BETWEEN 1 AND 64 AND phone_field NOT GLOB '*[^]A-Za-z0-9_.[-]*')),
  name_field TEXT CONSTRAINT forms_name_field_shape CHECK (name_field IS NULL OR (length(name_field) BETWEEN 1 AND 64 AND name_field NOT GLOB '*[^]A-Za-z0-9_.[-]*')),
  consent_text TEXT CONSTRAINT forms_consent_text_length CHECK (consent_text IS NULL OR length(consent_text) BETWEEN 1 AND 2000),
  CONSTRAINT forms_identity_field CHECK (email_field IS NOT NULL OR phone_field IS NOT NULL),
  CONSTRAINT forms_fields_distinct CHECK (
    (email_field IS NULL OR phone_field IS NULL OR email_field <> phone_field)
    AND (email_field IS NULL OR name_field IS NULL OR email_field <> name_field)
    AND (phone_field IS NULL OR name_field IS NULL OR phone_field <> name_field)
  ),
  UNIQUE (organization_id, id)
) STRICT;

-- At most one live form per (organisation, name) ignoring ASCII case; a deleted twin is allowed, so a name is free again after its form is deleted.
CREATE UNIQUE INDEX idx_forms_live_name ON forms (organization_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;

CREATE TABLE form_allowed_origins (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  form_id TEXT NOT NULL,
  origin TEXT NOT NULL CONSTRAINT form_allowed_origins_origin_length CHECK (length(origin) BETWEEN 1 AND 253),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  CONSTRAINT form_allowed_origins_form_fk FOREIGN KEY (organization_id, form_id) REFERENCES forms (organization_id, id),
  CONSTRAINT form_allowed_origins_unique UNIQUE (form_id, origin)
) STRICT;

CREATE TABLE form_tags (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  form_id TEXT NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  CONSTRAINT form_tags_form_fk FOREIGN KEY (organization_id, form_id) REFERENCES forms (organization_id, id),
  CONSTRAINT form_tags_unique UNIQUE (form_id, tag_id)
) STRICT;
