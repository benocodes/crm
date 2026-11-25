-- Forms: the visitor check is a per-form setting, not a hard rule. `challenge` is 'none' (no check: honeypot, origin allow-list, blocklist and rate limits still apply) or
-- 'turnstile' (the visitor must pass Cloudflare Turnstile). Additive: every existing form takes 'turnstile', so no form's behaviour changes; forms.create defaults a new form to 'none'.
ALTER TABLE forms ADD COLUMN challenge TEXT NOT NULL DEFAULT 'turnstile' CONSTRAINT forms_challenge CHECK (challenge IN ('none', 'turnstile'));
