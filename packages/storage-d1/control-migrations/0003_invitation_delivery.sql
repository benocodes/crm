-- Control 0003 (CORE248 D3). How an invitation reached its address: 'link' (the owner was handed the link, today's behaviour and every row written before this migration) or 'email' (the vault sent it and never returned the token).
-- Acceptance reads it to decide users.email_verified (CORE248 D5). Forward-only; existing rows take the default.

alter table invitations add column delivery text not null default 'link' check (delivery in ('link', 'email'));
