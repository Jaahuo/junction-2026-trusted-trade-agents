# Hosted deploy

The demo runs on one Vultr instance and one Tiger Data PostgreSQL service. OpenTofu in `infra/` creates both. Caddy provides automatic TLS and proxies to the container. `scripts/deploy.ts` deploys a private GHCR image. Decision: #37; tasks: #84 and #106.

## Prerequisites

- `mise install` provides the pinned OpenTofu.
- A Vultr API key with your client IP allowed, and a Tiger Data project id with client credentials.
- An SSH key at `~/.ssh/id_ed25519.pub`, or set `TF_VAR_ssh_public_key_path`.
- The challenge data files in `data/`.
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

The image targets `linux/amd64`. Its build uses Bun 1.4.3 and Node 24.22.2. Its runtime uses Bun 1.4.3 on Alpine with pinned security updates. It installs production dependencies without automatic peer dependencies. Each runtime dependency must be declared explicitly; build tools stay in the build stage. It contains the application, migrations, fixtures, skill assets, built web app and views. It must not contain challenge data or secrets. Keep the GHCR package private.

The root manifest declares Elysia's required peers (`typebox`, `exact-mirror` and `openapi-types`) explicitly. Knip excludes these declarations because Elysia consumes them indirectly. Do not remove them as unused packages. The image gate starts the production container against disposable PostgreSQL before it records release evidence.

For a manual deploy, select a published digest from a successful deployment record. Obtain a GitHub token with `read:packages` access. Enter the token without echoing it. The deploy script passes it to the host through standard input, not as a command argument. Verify the host's SSH fingerprint through the provider console before adding it to `~/.ssh/known_hosts`.

```sh
export DEPLOY_REGISTRY_USER=jaahuo
read -rs DEPLOY_REGISTRY_TOKEN
export DEPLOY_REGISTRY_TOKEN
export DEPLOY_IMAGE="ghcr.io/jaahuo/junction-2026-trusted-trade-agents@sha256:<64-character digest from deployment evidence>"
```

Stop if the digest has no matching successful gate and image scan evidence. The workflow publishes the scanned image without rebuilding it. Manual deployment does not run those checks for you. For an initial deployment, reset the database with the hosted keys, then deploy:

```sh
bun scripts/deploy.ts reset --yes
bun scripts/deploy.ts push
```

`push` requires the fixed repository and an exact SHA-256 image digest before it changes the host. It does not build an image or copy the checkout. It verifies the known SSH host key, waits for cloud-init, installs and starts Docker, and pulls the digest before stopping the service. It uses a temporary Docker configuration for registry access. It stores the digest as `TRUSTED_TRADE_IMAGE` in `/etc/trusted-trade-image.env`, separate from the app environment. The service starts that digest without pulling, so restarts do not need registry credentials.

`push` copies only `data/`, without `--delete`, to the host. It makes transferred and retained files readable by container UID 1000 without adding group or public access. The container mounts that directory read-only at `/app/data`. It writes `/etc/trusted-trade.env` and the Caddyfile, starts the service, and waits for `/api/health`. The server runs `bun apps/api/src/main.ts` from `/app` and migrates on start. An existing VM moves to the container service on `push`; it does not need another `tofu apply` or replacement.

`reset --yes` replaces the hosted demo data. It drops only the tables and types that each context's migrations create, and their migration records, because the TimescaleDB extension lives in the hosted `public` schema. It uses no CASCADE and runs in one transaction, so a foreign object that depends on ours aborts the reset before anything is dropped. Then it migrates and seeds like `bun run db:reset`, with the keys from `env.deploy`, so the seeded mandate verifies on the host.

The URL is `tofu -chdir=infra output -raw public_base_url`: `https://<ip>.sslip.io`, or `https://<domain>` with `TF_VAR_domain` and a DNS A record to `public_ip`. Connect the host to `<url>/mcp`.

## Automatic deploy from main

`.github/workflows/deploy.yml` runs after a successful main-push `gate`, or by hand on `main`. It selects the current main commit's successful push gate run and its exact run attempt. It verifies that run's image archive, scan, SBOM and manifest checksums, then publishes that same image to private GHCR. The deploy job receives its immutable digest. It never rebuilds an image or consumes PR artifacts. Publication has package write access; deployment has package read access and the production secrets. Deployment remains serialized and checks main again before changing the host. Scheduled gates never deploy. It never resets data.

After the first `apply` and `push`, set the secrets of the `production` environment:

```sh
gh secret set DEPLOY_SSH_KEY --env production < ~/.ssh/trusted-trade-ci
gh secret set DEPLOY_ENV --env production < ~/.config/trusted-trade/env.deploy
tofu -chdir=infra output -json | gh secret set DEPLOY_OUTPUTS --env production
# Obtain this entry through a trusted channel and verify its fingerprint in the provider console first.
gh secret set DEPLOY_KNOWN_HOSTS --env production < verified_known_hosts
```

`DEPLOY_OUTPUTS` holds the database URL. Set it again after any `apply` that changes an output. The challenge data ships in a separate step without `--delete`, so a CI push never removes the data files that are not in Git.

### Security and audit evidence

The [delivery gates](workflow.md#ci-stages-and-security-evidence) define the severity policy and evidence limits. Gate artifacts bind the image archive, CycloneDX SBOM and scan report to the commit, lockfile, run and attempt. Deployment evidence records the published digest and result without credentials. Artifacts remain private and expire after 90 days. Preserve the records elsewhere before expiry if your audit period is longer. Registry images require a separate retention policy.

All four production secrets are required, including `DEPLOY_KNOWN_HOSTS`. A missing secret is not a successful deployment. Verify a successful health check and the digest in deployment evidence before reporting a release.

The current private repository plan does not support branch protection. At inspection, the production environment also has no approval or branch restrictions. These workflows do not prevent an authorized account from bypassing them. Configure and verify server-side controls on an eligible plan before claiming enforced release approval. This change does not upgrade the plan, expose the repository, or configure those controls.

## Update, inspect and remove

- Deploy a published image by hand: set `DEPLOY_IMAGE` and the registry variables above, then run `bun scripts/deploy.ts push`.
- To roll back, select an earlier retained digest with its gate and deployment evidence. Set `DEPLOY_IMAGE` and run `push` with fresh `read:packages` credentials. Do not rebuild the image or reset the database. Roll back only if the earlier image is compatible with the current database schema. A code rollback does not reverse migrations or restore data.
- Remove the token from the shell after deployment: `unset DEPLOY_REGISTRY_TOKEN`. If you used Docker login locally, run `docker logout ghcr.io`.
- Check health: `bun scripts/deploy.ts health`.
- Logs: `ssh root@$(tofu -chdir=infra output -raw public_ip) journalctl -u trusted-trade -f`.
- After the event: `tofu -chdir=infra destroy`. The Tiger Data credit lasts 30 days.

Whoever holds `~/.config/trusted-trade/terraform.tfstate` owns the deploy.
