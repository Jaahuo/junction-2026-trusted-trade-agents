# Hosted deploy

The demo runs on one Vultr instance and one Tiger Data PostgreSQL service. OpenTofu in `infra/` creates both. Caddy provides automatic TLS and proxies to the container. `scripts/deploy.ts` deploys a private GHCR image. Decision: #37; tasks: #84 and #106.

## Prerequisites

- `mise install` provides the pinned OpenTofu.
- A Vultr API key with your client IP allowed, and a Tiger Data project id with client credentials.
- An SSH key at `~/.ssh/id_ed25519.pub`, or set `TF_VAR_ssh_public_key_path`.
- The challenge data files in `data/`.
- Docker with Buildx, and access to the private `ghcr.io/jaahuo/junction-2026-trusted-trade-agents` package.
- Python 3 on the machine that runs `push`, for hosted chat provisioning.

## Operator files

The deploy owner keeps three files in one private folder outside every checkout, because a task worktree is deleted after its PR merges:

| File in `~/.config/trusted-trade/` | Holds                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `env.tofu`                         | the Vultr and Tiger Data credentials                                           |
| `env.deploy`                       | the app signing keys; a new offer key invalidates every offer issued before it |
| `terraform.tfstate`                | the OpenTofu state, including the database password                            |

```sh
# ~/.config/trusted-trade/env.tofu
TF_VAR_vultr_api_key=      # Vultr: Account > API; allow your IP under Access Control
TF_VAR_ts_project_id=      # Tiger Console: project settings
TF_VAR_ts_access_key=      # Tiger Console: Settings > Create credentials, public key
TF_VAR_ts_secret_key=      # same dialog, secret key (shown once)
```

Create the app keys once, and the CI key before the first `apply`, because it is authorized only at creation:

```sh
mkdir -p -m 700 ~/.config/trusted-trade
bun scripts/generate-keys.ts > ~/.config/trusted-trade/env.deploy
ssh-keygen -t ed25519 -N "" -C trusted-trade-ci -f ~/.ssh/trusted-trade-ci
```

Add other app settings, such as `MCP_VIEW_TOOLS`, to `env.deploy`. Load the operator environment in each shell, from any checkout:

```sh
set -a && . ~/.config/trusted-trade/env.tofu && set +a
export DEPLOY_ENV_FILE=~/.config/trusted-trade/env.deploy TF_VAR_ci_ssh_public_key="$(cat ~/.ssh/trusted-trade-ci.pub)"
tofu -chdir=infra init -backend-config=path="$HOME/.config/trusted-trade/terraform.tfstate"
```

## Create and ship

Create infrastructure only for a new deployment:

```sh
tofu -chdir=infra apply
```

The image targets `linux/amd64`. Its build uses Bun 1.4.3 and Node 24.22.2; its runtime uses Bun 1.4.3. It contains the application, migrations, fixtures, skill assets, built web app and views. It must not contain challenge data or secrets. Keep the GHCR package private.

For a manual deploy, select the exact commit and obtain a GitHub token with `read:packages` access to the private package. Enter the token without echoing it. The deploy script passes it to the host through standard input, not as a command argument.

```sh
export DEPLOY_REGISTRY_USER=jaahuo
read -rs DEPLOY_REGISTRY_TOKEN
export DEPLOY_REGISTRY_TOKEN
export DEPLOY_IMAGE="ghcr.io/jaahuo/junction-2026-trusted-trade-agents:$(git rev-parse HEAD)"
```

Use a full 40-character lowercase commit SHA as the tag. Publish the image separately before `push`. Never overwrite an existing SHA tag: reuse the existing image. If the tag does not exist, build from the selected clean checkout and publish it with a token that also has `write:packages`:

```sh
printf '%s' "$DEPLOY_REGISTRY_TOKEN" | docker login ghcr.io -u "$DEPLOY_REGISTRY_USER" --password-stdin
docker buildx build --platform linux/amd64 \
  --label org.opencontainers.image.source=https://github.com/jaahuo/junction-2026-trusted-trade-agents \
  --label "org.opencontainers.image.revision=${DEPLOY_IMAGE##*:}" \
  --tag "$DEPLOY_IMAGE" --push .
```

Stop if the image cannot be published or read. Do not treat authentication or registry errors as proof that a tag is missing. For an initial deployment, reset the database with the hosted keys, then deploy:

```sh
bun scripts/deploy.ts reset --yes
bun scripts/deploy.ts push
```

`push` requires the fixed repository and full SHA tag before it changes the host. It does not build an image or copy the checkout. It waits for cloud-init, installs and starts Docker, and pulls the image before stopping the service. It uses a temporary Docker configuration for registry access. It resolves the image to a digest and stores it as `TRUSTED_TRADE_IMAGE` in `/etc/trusted-trade-image.env`, separate from the app environment. The service starts that digest without pulling, so restarts do not need registry credentials.

`push` copies only `data/`, without `--delete`, to the host. It makes transferred and retained files readable by container UID 1000 without adding group or public access. The container mounts that directory read-only at `/app/data`. It writes `/etc/trusted-trade.env` and the Caddyfile, starts the service, and waits for `/api/health`. The server runs `bun apps/api/src/main.ts` from `/app` and migrates on start. An existing VM moves to the container service on `push`; it does not need another `tofu apply` or replacement.

`reset --yes` replaces the hosted demo data. It drops only the tables and types that each context's migrations create, and their migration records, because the TimescaleDB extension lives in the hosted `public` schema. It uses no CASCADE and runs in one transaction, so a foreign object that depends on ours aborts the reset before anything is dropped. Then it migrates and seeds like `bun run db:reset`, with the keys from `env.deploy`, so the seeded mandate verifies on the host.

The URL is `tofu -chdir=infra output -raw public_base_url`: `https://<ip>.sslip.io`, or `https://<domain>` with `TF_VAR_domain` and a DNS A record to `public_ip`. Connect the host to `<url>/mcp`.

## Automatic deploy from main

`.github/workflows/deploy.yml` runs after `gate` finishes on a push to `main`, or by hand on `main`. Each run deploys the current `main` head once its push gate passed, so a late or rerun gate never rolls back. One deploy runs at a time. CI uses its ephemeral GitHub token for package access. It reuses the SHA image if present and builds it only when the manifest is not found. It never resets data. Until the secrets below exist, it skips with a note in the run summary.

After the first `apply` and `push`, set the secrets of the `production` environment:

```sh
gh secret set DEPLOY_SSH_KEY --env production < ~/.ssh/trusted-trade-ci
gh secret set DEPLOY_ENV --env production < ~/.config/trusted-trade/env.deploy
tofu -chdir=infra output -json | gh secret set DEPLOY_OUTPUTS --env production
ssh-keyscan -t ed25519 "$(tofu -chdir=infra output -raw public_ip)" | gh secret set DEPLOY_KNOWN_HOSTS --env production
```

`DEPLOY_OUTPUTS` holds the database URL. Set it again after any `apply` that changes an output. The challenge data ships in a separate step without `--delete`, so a CI push never removes the data files that are not in Git.

## Hosted chat

`push` also runs Open WebUI v0.13.3 at `https://chat.<hostname>` when `VERDA_INFERENCE_KEY` is set (#155).
Without that key it skips the chat host and changes nothing else.
The chat host uses the OpenAI-compatible Verda endpoint `https://containers.datacrunch.io/nemotron-3-5-super-vl-b300/v1` with the base model `nemotron-3.5-super-vl`, and connects to `<url>/mcp` of the same deployment.
Login is on and sign-up is off, because the inference key pays for every chat.
Sign in with the admin account. Choose Acme Kitchens or Acme Bakery; Acme Kitchens is the default.

The managed presets use the shared [purchasing prompt](../hosts/openwebui/agent/purchasing.md).
They combine concise ordering replies with structured recipe planning.
The main project's ordering skill and reason-code reference are embedded in both system prompts.
Valio Aimo recipe reads are off by default pending permission.
For an authorized manual deployment, set `VALIO_AIMO_RECIPE_PERMISSION=True` in the deployment process environment.
The deploy forwards that flag to provisioning and the chat container.
The MCP connection supplies purchasing tools; the server controls approval and buying authority.
The presets do not create a buyer account or grant purchasing rights.

For the chat host, `push` copies only `hosts/openwebui/agent`, `branding` and `scripts` to `/opt/trusted-trade-chat`.
It excludes environment files and Python caches.
The service mounts the branding files read-only and keeps chat data in its existing volume.
After the service starts, the deploy runs the local Python provisioner against the hosted URL.
It embeds the local ordering skill and configures the inference endpoint, MCP connection and managed presets.
Title, follow-up and tag generation are disabled; voice remains available.

Keep the chat secrets in a fourth operator file, `~/.config/trusted-trade/env.chat`:

```sh
# The Verda inference key.
VERDA_INFERENCE_KEY=
# openssl rand -hex 32. Keep it stable, or sessions end at the next deploy.
OPENWEBUI_SECRET_KEY=
# The one chat login.
OPENWEBUI_ADMIN_EMAIL=
# openssl rand -base64 18
OPENWEBUI_ADMIN_PASSWORD=
```

Keep comments on their own lines: the loop below stores everything after `=` as the secret.

Open WebUI creates the admin account only at its first start, so a later password change in the file does not change the login.
For a manual `push`, load the file first with `set -a && . ~/.config/trusted-trade/env.chat && set +a`.
For CI, set each line as a secret of the `production` environment:

```sh
grep -E '^[A-Z_]+=' ~/.config/trusted-trade/env.chat | while IFS='=' read -r name value; do printf '%s' "$value" | gh secret set "$name" --env production; done
```

With `TF_VAR_domain`, add a DNS A record for `chat.<domain>` as well. The `sslip.io` name resolves without one.
The chat data lives in the Docker volume `trusted-trade-chat` on the VM; `journalctl -u trusted-trade-chat` shows its log.
To turn the chat host off, delete the four secrets, deploy, and run `systemctl disable --now trusted-trade-chat && rm /etc/trusted-trade-chat.env` on the VM, because a deploy without the key leaves the chat unit as it is.

## Update, inspect and remove

- Deploy a published image by hand: set `DEPLOY_IMAGE` and the registry variables above, then run `bun scripts/deploy.ts push`.
- To roll back, select an earlier retained full SHA image in `DEPLOY_IMAGE` and run the same `push` with fresh `read:packages` credentials. Do not rebuild the image or reset the database. Roll back only if the earlier image is compatible with the current database schema.
- Remove the token from the shell after deployment: `unset DEPLOY_REGISTRY_TOKEN`. If you used Docker login locally, run `docker logout ghcr.io`.
- Check health: `bun scripts/deploy.ts health`.
- Logs: `ssh root@$(tofu -chdir=infra output -raw public_ip) journalctl -u trusted-trade -f`.
- After the event: `tofu -chdir=infra destroy`. The Tiger Data credit lasts 30 days.

Whoever holds `~/.config/trusted-trade/terraform.tfstate` owns the deploy.
