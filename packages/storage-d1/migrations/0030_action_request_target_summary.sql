-- AGT588 D7: the server-written, one-line summary of what a request asks for, written once by action_requests.create in the same insert (as proposed;
-- an approval with edited arguments does not rewrite it). Nullable and never backfilled: a request created before this migration reads NULL and clients
-- fall back to the operation name. No dedicated filter, index or sort (the generic column filters apply, CORE199).
ALTER TABLE action_requests ADD COLUMN target_summary TEXT CONSTRAINT action_requests_target_summary CHECK (target_summary IS NULL OR length(target_summary) BETWEEN 1 AND 500);
