---
"@vibase/server-d1": minor
---

New `vibase-server init`: asks for (or takes as flags) the instance's name, API host, owner email and auth and email providers, then writes its secrets file with mode 600, never over an existing file, with the generated secrets in and an empty line for each value you supply, and prints the `setup --dry-run` command to run next. `vibase-server setup` now turns Gmail off, with a header line naming the two Google client values, when neither is set, instead of refusing a file that holds only the generated Gmail keys; its "no secrets file" refusal points at `init`.
