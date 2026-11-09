-- CORE194 cycle 1 (D4, D5, D6): standalone FTS5 trigram search indexes for companies, notes and tasks, kept by triggers.
-- Derived, rebuildable machinery, not resources: no events, no organization_id (one organisation per D1 database, CORE35 D18).
-- The update trigger fires only for the indexed columns and deleted_at: removing an entry scans the index (id is UNINDEXED), so an
-- update of anything else must not pay for it.
-- The id column is UNINDEXED; the predicate joins back to the base table (live rows, scoping). Populated from the live rows below.

CREATE VIRTUAL TABLE companies_search USING fts5(id UNINDEXED, name, domain, tokenize = 'trigram');

INSERT INTO companies_search (id, name, domain) SELECT id, name, domain FROM companies WHERE deleted_at IS NULL;

CREATE TRIGGER companies_search_ai AFTER INSERT ON companies
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO companies_search (id, name, domain) VALUES (new.id, new.name, new.domain);
END;

CREATE TRIGGER companies_search_au AFTER UPDATE OF name, domain, deleted_at ON companies
BEGIN
  DELETE FROM companies_search WHERE id = old.id;
  INSERT INTO companies_search (id, name, domain) SELECT new.id, new.name, new.domain WHERE new.deleted_at IS NULL;
END;

CREATE TRIGGER companies_search_ad AFTER DELETE ON companies
BEGIN
  DELETE FROM companies_search WHERE id = old.id;
END;

CREATE VIRTUAL TABLE notes_search USING fts5(id UNINDEXED, title, content, tokenize = 'trigram');

INSERT INTO notes_search (id, title, content) SELECT id, title, content FROM notes WHERE deleted_at IS NULL;

CREATE TRIGGER notes_search_ai AFTER INSERT ON notes
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO notes_search (id, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER notes_search_au AFTER UPDATE OF title, content, deleted_at ON notes
BEGIN
  DELETE FROM notes_search WHERE id = old.id;
  INSERT INTO notes_search (id, title, content) SELECT new.id, new.title, new.content WHERE new.deleted_at IS NULL;
END;

CREATE TRIGGER notes_search_ad AFTER DELETE ON notes
BEGIN
  DELETE FROM notes_search WHERE id = old.id;
END;

CREATE VIRTUAL TABLE tasks_search USING fts5(id UNINDEXED, title, notes, tokenize = 'trigram');

INSERT INTO tasks_search (id, title, notes) SELECT id, title, notes FROM tasks WHERE deleted_at IS NULL;

CREATE TRIGGER tasks_search_ai AFTER INSERT ON tasks
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO tasks_search (id, title, notes) VALUES (new.id, new.title, new.notes);
END;

CREATE TRIGGER tasks_search_au AFTER UPDATE OF title, notes, deleted_at ON tasks
BEGIN
  DELETE FROM tasks_search WHERE id = old.id;
  INSERT INTO tasks_search (id, title, notes) SELECT new.id, new.title, new.notes WHERE new.deleted_at IS NULL;
END;

CREATE TRIGGER tasks_search_ad AFTER DELETE ON tasks
BEGIN
  DELETE FROM tasks_search WHERE id = old.id;
END;
