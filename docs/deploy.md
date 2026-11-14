# Hosted deploy

The demo runs on one Vultr instance (Bun behind Caddy with automatic TLS) and one Tiger Data PostgreSQL service. OpenTofu in `infra/` creates both. `scripts/deploy.ts` ships the current worktree. Decision: #37; task: #84.

## Prerequisites

- `mise install` provides the pinned OpenTofu.
- A Vultr API key with your client IP allowed, and a Tiger Data project id with client credentials.
- An SSH key at `~/.ssh/id_ed25519.pub`, or set `TF_VAR_ssh_public_key_path`.
- The challenge data files in `data/`.

Put the credentials in ignored `.env` and export them as `TF_VAR_*`, never in Git:

```sh
export TF_VAR_vultr_api_key=... TF_VAR_ts_project_id=... TF_VAR_ts_access_key=... TF_VAR_ts_secret_key=...
```

Create the app secrets once and keep them. A new offer key invalidates every offer issued before it:

```sh
bun scripts/generate-keys.ts > .env.deploy
```

Add other app settings, such as `MCP_VIEW_TOOLS`, to `.env.deploy`.

## Create and ship

```sh
tofu -chdir=infra init
tofu -chdir=infra apply
bun scripts/deploy.ts reset --yes
bun scripts/deploy.ts push
```

`push` builds the web app and the views locally, waits for cloud-init, copies the worktree with rsync (without `.git`, `node_modules`, `.env*` and `infra/`), writes `/etc/trusted-trade.env` and the Caddyfile, installs dependencies, restarts the service and waits for `/api/health`. The server runs from source with `bun apps/api/src/main.ts` and migrates on start.

`reset --yes` replaces the hosted demo data. It drops only the tables and types that each context's migrations create, and their migration records, because the TimescaleDB extension lives in the hosted `public` schema. It uses no CASCADE and runs in one transaction, so a foreign object that depends on ours aborts the reset before anything is dropped. Then it migrates and seeds like `bun run db:reset`, with the keys from `.env.deploy`, so the seeded mandate verifies on the host.

The URL is `tofu -chdir=infra output -raw public_base_url`: `https://<ip>.sslip.io`, or `https://<domain>` with `TF_VAR_domain` and a DNS A record to `public_ip`. Connect the host to `<url>/mcp`.

## Automatic deploy from main

`.github/workflows/deploy.yml` runs `bun scripts/deploy.ts push` after `gate` passes on a push to `main`, on the commit that gate checked. One deploy runs at a time. It never resets data. Until the secrets below exist, it skips with a note in the run summary. `workflow_dispatch` runs it by hand.

The CI key must be on the instance from creation, so create it before the first `apply`:

```sh
ssh-keygen -t ed25519 -N "" -C trusted-trade-ci -f ~/.ssh/trusted-trade-ci
export TF_VAR_ci_ssh_public_key="$(cat ~/.ssh/trusted-trade-ci.pub)"
```

After the first `apply` and `push`, set the repository secrets (environment `production`):

```sh
gh secret set DEPLOY_SSH_KEY --env production < ~/.ssh/trusted-trade-ci
gh secret set DEPLOY_ENV --env production < .env.deploy
tofu -chdir=infra output -json | gh secret set DEPLOY_OUTPUTS --env production
ssh-keyscan -t ed25519 "$(tofu -chdir=infra output -raw public_ip)" | gh secret set DEPLOY_KNOWN_HOSTS --env production
```

`DEPLOY_OUTPUTS` holds the database URL. Set it again after any `apply` that changes an output. The challenge data ships in a separate step without `--delete`, so a CI push never removes the data files that are not in Git.

## Update, inspect and remove

- Ship a new commit: `bun scripts/deploy.ts push`.
- Check health: `bun scripts/deploy.ts health`.
- Logs: `ssh root@$(tofu -chdir=infra output -raw public_ip) journalctl -u trusted-trade -f`.
- After the event: `tofu -chdir=infra destroy`. The Tiger Data credit lasts 30 days.

`infra/terraform.tfstate` holds the database password. It stays on the machine that ran `apply` and is ignored by Git; whoever holds it owns the deploy.
