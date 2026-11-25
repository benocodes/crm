#!/usr/bin/env bash
# Email the owner a sprint notice via AgentMail. Usage: scripts/notify-owner.sh "<subject>" "<body>"
# Reads AGENTMAIL_API_KEY from the gitignored .env of the main checkout; never prints it.
set -euo pipefail
root="$(git rev-parse --path-format=absolute --git-common-dir)/.."
key="$(grep -E '^AGENTMAIL_API_KEY=' "$root/.env" | head -1 | cut -d= -f2- | tr -d "\"'")"
[ -n "$key" ] || { echo "AGENTMAIL_API_KEY missing in .env" >&2; exit 1; }
payload="$(node -e 'console.log(JSON.stringify({to:"ori@makelinks.co",subject:process.argv[1],text:process.argv[2]}))' "$1" "$2")"
curl -sf -X POST https://api.agentmail.to/v0/inboxes/vibase@agentmail.to/messages/send \
  -H "Authorization: Bearer $key" -H "Content-Type: application/json" -d "$payload" >/dev/null && echo "sent"
