---
title: Set up without init, or in CI
description: Create an instance with flags and files instead of the interactive questions, keep the files elsewhere, and run without a terminal.
---

`vibase-server init` is the normal way to start. Use this page when there is no terminal (a script or CI), or when you want the files somewhere else.

## Where the files live

An instance has two files outside the package, so upgrading never touches them:

- Settings: `$XDG_CONFIG_HOME/vibase/instances/<name>.json` (`~/.config` when unset). `setup` writes it.
- Secrets: `<name>.env` beside it, mode 600, dotenv format. The program refuses a file that other users can read.

To keep them elsewhere, name them on every command:

```bash
vibase-server status --env mycompany --settings ./mycompany.json --secrets-file ./mycompany.env
```

## Init with flags

Every question init asks has a flag, and with no terminal the flags are all it has:

```bash
vibase-server init --env mycompany --api-host api.example.com --owner-email you@example.com
```

Run `vibase-server init --help` for the flags for the auth and email providers.

## Write the secrets file by hand

A secrets file you wrote works too. It needs your Cloudflare values:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
```

Setup generates a missing `AUTH_SECRET` (the key that signs sessions), appends it to the file before it puts it on the Worker, and never prints it. Keep the file: a rerun reads the secret from it.

## Set up without init

With no settings file from init, give the host and the owner on the first run:

```bash
vibase-server setup --env mycompany --api-host api.example.com --owner-email owner@example.com
```

After init, `setup --env mycompany` is the whole command: the host, the provider and the owner email come from the settings file, and a flag that differs from them is refused.

## Skip the questions

`setup`, `upgrade`, `redeploy` and `owner-reset` print their plan and ask `proceed? [Y/n]` once, before the first change. `n` stops with nothing changed. `--yes` (`-y`) skips the question, and so does a run with no terminal on stdin. `--dry-run` reads only and never asks.
