# Hosted deploy

The demo runs on one Vultr instance and one Tiger Data PostgreSQL service. OpenTofu in `infra/` creates both. Caddy provides automatic TLS and proxies to the containers. `scripts/deploy.ts` deploys private GHCR images. Decision: #37; tasks: #84 and #106.

## Prerequisites

- `mise install` provides the pinned OpenTofu.
- A Vultr API key with your client IP allowed, and a Tiger Data project id with client credentials.
- An SSH key at `~/.ssh/id_ed25519.pub`, or set `TF_VAR_ssh_public_key_path`.
- An approved catalogue import into the target database before deploying the PostgreSQL-only API. See [catalogue import](catalogue-import.md).
- Docker with Buildx, and access to the private `ghcr.io/jaahuo/junction-2026-trusted-trade-agents` package.

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

The main API image targets `linux/amd64`. Its build uses Bun 1.4.3 and Node 24.22.2. Its runtime uses the digest-pinned official Bun 1.4.3 distroless image as UID 1000. It has no OS shell or package manager. A separate stage installs production dependencies without automatic peer dependencies. Each runtime dependency must be declared explicitly; build tools stay outside the runtime. The final stage copies the application, migrations, fixtures, skill assets and built web/view assets. It excludes the unused compiled API binary and build-stage dependencies. Neither the API image nor the chat image contains challenge data or secrets. Keep the GHCR package private.

The root manifest declares Elysia's required peers (`typebox`, `exact-mirror` and `openapi-types`) explicitly. Knip excludes these declarations because Elysia consumes them indirectly. Do not remove them as unused packages. The publication job starts the production container against disposable PostgreSQL before it publishes the image.

The publication job uses Bun to verify the runtime UID and the absence of common shells and package managers. It does not depend on `sh` or `id` inside the container. Use `docker exec trusted-trade /usr/local/bin/bun -e 'console.log(process.getuid())'` to inspect the UID. Rebuild the image for dependency or OS updates; do not install tools into the running container.

For a manual deploy, select published digests from a successful deployment record. When chat is enabled, select the API and chat digests built from the same source SHA. Obtain a GitHub token with `read:packages` access. Enter the token without echoing it. The deploy script passes it to the host through standard input, not as a command argument. Verify the host's SSH fingerprint through the provider console before adding it to `~/.ssh/known_hosts`.

```sh
export DEPLOY_REGISTRY_USER=jaahuo
read -rs DEPLOY_REGISTRY_TOKEN
export DEPLOY_REGISTRY_TOKEN
export DEPLOY_IMAGE="ghcr.io/jaahuo/junction-2026-trusted-trade-agents@sha256:<64-character digest from deployment evidence>"
# Required when VERDA_INFERENCE_KEY enables hosted chat.
export DEPLOY_CHAT_IMAGE="ghcr.io/jaahuo/junction-2026-trusted-trade-agents@sha256:<64-character chat digest from deployment evidence>"
```

Stop if either selected digest has no matching deployment identity evidence. Dependency audits, image vulnerability scans and SBOM generation are temporarily paused under #233. Manual deployment does not run those checks for you. For an initial deployment, reset the database with the hosted keys, then deploy:

```sh
bun scripts/deploy.ts reset --yes
bun scripts/deploy.ts push
```

`push` requires the fixed repository and an exact SHA-256 API image digest before it changes the host. When chat is enabled, it also requires a chat image digest from the same repository. It does not build an image or copy the checkout. It verifies the known SSH host key, waits for cloud-init, installs and starts Docker, and pulls the required digests before stopping the service. It uses a temporary Docker configuration for registry access. It stores the API digest as `TRUSTED_TRADE_IMAGE` in `/etc/trusted-trade-image.env`, separate from the app environment. The service starts that digest without pulling, so restarts do not need registry credentials.

`push` does not transfer catalogue files or mount a host data directory. It writes `/etc/trusted-trade.env` and the Caddyfile, starts the service, and waits for `/api/health`. It then verifies the running container's image ID against the selected digest. Health alone does not prove the catalogue is imported. Verify search and facts before the cutover. Keep legacy host source files until an operator approves their separate removal.

`reset --yes` replaces hosted transactional demo data but preserves catalogue tables and their migration records. It drops only other contexts' migration-owned tables, types and ledgers, without CASCADE. A foreign dependency aborts the drop transaction. It then migrates and seeds with the keys from `env.deploy`. Imported demo metadata supplies order history; no import or source-file read occurs during reset.

The URL is `tofu -chdir=infra output -raw public_base_url`: `https://<ip>.sslip.io`, or `https://<domain>` with `TF_VAR_domain` and a DNS A record to `public_ip`. Connect the host to `<url>/mcp`.

## Automatic deploy from main

`.github/workflows/deploy.yml` runs on every push to `main`, or by hand on `main`. It does not wait for a gate. Two parallel jobs build the API and chat amd64 images from the pushed commit and push them to the same private GHCR repository. PR gates do not build images.
Each build job reads the pushed manifest back, verifies its content hash and compares its config digest with the one the build reported. A mismatch stops deployment. Tags include the source SHA and run id and attempt, so rebuilds do not overwrite each other's tag. The deploy job receives immutable digests for both images.
After a successful push, manifest read-back can return a temporary 404. Verification makes at most six read attempts, with two seconds between 404 responses. Each request has a 30-second limit. Other HTTP errors and transport failures stop immediately.
Builds of different commits run side by side and are never cancelled. Before the deploy job, the `turn` job waits until every earlier run of the workflow on main has completed, whatever its result. Commits therefore deploy in push order, one at a time. A pipeline skips deployment when a later run's deploy job is queued, running or successful. This stops a re-run of an old pipeline from replacing newer images. The `turn` job and the deploy job both make this check. A skipped run writes a `Skipped:` summary line and ends green.
Two smoke jobs follow the deploy job. They are off unless the repository variable `DEPLOY_SMOKE` is `true`. When on, they pull the deployed digests and run them on the runner; the API smoke uses a disposable PostgreSQL with a fictional catalogue. A smoke failure fails the run but does not roll production back.
`bun run ship` warns when the latest completed deployment failed. The build jobs have package write access but no production environment or deployment secrets. Only they can write the Docker layer cache. Deployment has package read access and the production secrets. It installs with the frozen lockfile, remains serialized and removes its SSH key from the runner when it ends. All jobs run on the self-hosted runners that also run pull request code; see [delivery gates](workflow.md#ci-stages-and-security-evidence). Gates never deploy. Deployment never resets data.

After the first `apply` and `push`, set the secrets of the `production` environment:

```sh
gh secret set DEPLOY_SSH_KEY --env production < ~/.ssh/trusted-trade-ci
gh secret set DEPLOY_ENV --env production < ~/.config/trusted-trade/env.deploy
tofu -chdir=infra output -json | gh secret set DEPLOY_OUTPUTS --env production
# Obtain this entry through a trusted channel and verify its fingerprint in the provider console first.
gh secret set DEPLOY_KNOWN_HOSTS --env production < verified_known_hosts
```

`DEPLOY_OUTPUTS` holds the database URL. Set it again after any `apply` that changes an output. Deployment does not import or synchronize catalogue data.

### Security and audit evidence

The [delivery gates](workflow.md#ci-stages-and-security-evidence) describe the temporary security pause under #233 and its restoration path. There are no dependency audit reports, image vulnerability reports or SBOMs in this mode. Deployment evidence records source and lockfile identity, the build run, both image config digests, published digests and deployment result. It explicitly marks security scans as paused. Evidence expires after 90 days; Preserve records elsewhere before expiry when needed. Registry images require a separate retention policy.

The four application deployment secrets above are required, including `DEPLOY_KNOWN_HOSTS`. A missing secret is not a successful deployment. Verify a successful health check and the digest in deployment evidence before reporting a release.

The current private repository plan does not support branch protection. At inspection, the production environment also has no approval or branch restrictions. These workflows do not prevent an authorized account from bypassing them. Configure and verify server-side controls on an eligible plan before claiming enforced release approval. This change does not upgrade the plan, expose the repository, or configure those controls.

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
For automatic deployments, set the `production` environment variable with `gh variable set VALIO_AIMO_RECIPE_PERMISSION --env production --body True`.
Unset or false values keep recipe reads disabled.
The deploy forwards that flag to provisioning and the chat container.
The MCP connection supplies purchasing tools; the server controls approval and buying authority.
The presets do not create a buyer account or grant purchasing rights.

The chat image packages branding, agent assets, scripts and `skills/trusted-trade-ordering` under their checkout-relative paths in `/opt/trusted-trade`. The host does not receive these files through rsync or bind mounts. The service keeps chat data in its existing volume.
`push` stores the chat digest in `/etc/trusted-trade-chat-image.env` as `TRUSTED_TRADE_CHAT_IMAGE`. After starting the service, it verifies the running container's image ID against the pulled digest. It then uses `docker exec` to run the packaged Python provisioner inside the container. The provisioner uses the packaged ordering skill and configures the inference endpoint, MCP connection and managed presets. Hosted provisioning does not require Python on the operator machine.
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

- Deploy published images by hand: set `DEPLOY_IMAGE`, `DEPLOY_CHAT_IMAGE` when chat is enabled, and the registry variables above. Then run `bun scripts/deploy.ts push`.
- To roll back, select earlier retained digests from the same source SHA with their deployment evidence. Set `DEPLOY_IMAGE` and, when chat is enabled, `DEPLOY_CHAT_IMAGE`. Run `push` with fresh `read:packages` credentials. Do not rebuild the images or reset the database. Roll back only if the earlier API image is compatible with the current database schema. A code rollback does not reverse migrations or restore data.
- A pre-cutover file-backed API is not a drop-in rollback: this deployment no longer mounts its source directory. Follow the [catalogue rollback constraints](catalogue-import.md#recovery-and-rollback).
- Remove the token from the shell after deployment: `unset DEPLOY_REGISTRY_TOKEN`. If you used Docker login locally, run `docker logout ghcr.io`.
- Check health: `bun scripts/deploy.ts health`.
- Logs: `ssh root@$(tofu -chdir=infra output -raw public_ip) journalctl -u trusted-trade -f`.
- After the event: `tofu -chdir=infra destroy`. The Tiger Data credit lasts 30 days.

Whoever holds `~/.config/trusted-trade/terraform.tfstate` owns the deploy.
