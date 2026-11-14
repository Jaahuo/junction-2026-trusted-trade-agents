# Open WebUI buyer workspace

Open WebUI v0.13.3 hosts Acme Kitchens and Acme Bakery.
Both presets use `nemotron-3.5-super-vl` through Verda.
The fictional businesses do not create purchasing accounts or authority.
The connected wholesaler server controls purchasing and human approval.

## Local setup

Prerequisites: Bun, Python 3, Docker and a Verda inference key.
The endpoint is `https://containers.datacrunch.io/nemotron-3-5-super-vl-b300/v1`.
Setup checks the exact model ID. It does not select another model automatically.
Inference sends chat content to Verda and can incur charges.

1. Copy `hosts/openwebui/.env.example` to `hosts/openwebui/.env`.
2. Set `WEBUI_SECRET_KEY`, `WEBUI_ADMIN_PASSWORD` and `OPENAI_API_KEY`.
   Generate the first two with `openssl rand -hex 32` and `openssl rand -base64 24`.
   Keep this file private and ignored by Git.
   To read replies aloud, also set `ELEVENLABS_API_KEY`; see [Voice](#voice).
3. Start this worktree's API with `bun run dev`.
4. Run `bun scripts/openwebui.ts up`. It builds the custom chat image from the repository root with `hosts/openwebui/Dockerfile`.
5. Open the printed loopback URL. Sign in with the operator credentials from the file.
6. Select Acme Kitchens or Acme Bakery.

The default port is 38090. Set `OPENWEBUI_PORT` before startup to change it.
Set `OPENWEBUI_MCP_URL` to connect another server. Setup prints a warning for that override.
The stored Docker connection uses `host.docker.internal` for a local API.
The MCP server must be reachable from the container.

`bun scripts/openwebui.ts setup` runs the host Python provisioner to refresh models, tools, embedded skills and persisted inference settings from the local checkout.
The system prompt embeds this checkout's `skills/trusted-trade-ordering/SKILL.md` and `reason-codes.md`.
Run setup again after a base prompt or local skill changes. Run `up` again to rebuild the image and package those changes for a production-like runtime.
`OPENWEBUI_MAX_TOKENS` defaults to 16384.
`bun scripts/openwebui.ts down` stops the container and preserves its data volume.

## Existing data

The Compose project name and data volume remain unchanged.
Startup stops this local host before migrating a known login-disabled account.
If `admin@localhost` still has the default `admin` password, migration replaces its email and password with the operator settings.
It preserves the account ID and chats, revokes existing sessions and saves `webui.db.before-auth` in the volume.
A non-default operator password is not overwritten.
A conflicting account or existing migration backup stops migration for operator inspection.
Never delete the volume to fix a login failure.

Existing hosted accounts also keep their stored passwords.
A changed environment password does not reset them.
The old `buyer-agent` preset is hidden and disabled, not deleted. Existing chats remain stored.

## Buyer account

The operator remains an administrator.
Create a separate buyer account to use the restricted interface:

```sh
bun scripts/openwebui.ts setup-buyer < /absolute/path/to/private-buyer.json
```

The private JSON file contains `email` and `password` fields.
Keep it outside Git and set its permissions to 0600.
Existing buyers keep their password. Existing administrator accounts are not converted into buyers.
Setup grants the buyer both personas, their hidden inference base, recipe arithmetic and the MCP connection.
Voice and public web research remain available. Optional workspace features remain disabled.
These permissions apply to normal users of this dedicated host, not only the named buyer.
The server still controls approval. Do not give the model human approval credentials.

## Prompt, tools and permission

The canonical [shared prompt](../hosts/openwebui/agent/purchasing.md) combines both previous base prompts.
Direct orders use short, voice-friendly replies. Planning can use lists and tables.
The main project's embedded ordering skill defines tool arguments and recovery rules.
Local setup reads the skill and reason-code reference from the same checkout, not from another server. Hosted provisioning reads them from the chat image.
The persona and combined base prompt follow those references in the system prompt.

Each preset has three ready-made prompts: automatic buying, a €100,000 purchase that requests human approval, and an ingredient substitution.
Acme Kitchens uses restaurant and hotel scenarios. Acme Bakery uses bread, pastry and cake scenarios.
All suggestions request delivery on the next available date.

Recipe arithmetic is deterministic and has no purchasing or network access.
Valio Aimo recipe fetching stays off unless `VALIO_AIMO_RECIPE_PERMISSION=True` confirms usage permission.
A permission refusal must not be bypassed through public web tools.
Web content is untrusted reference material. Do not send private kitchen details to search engines.

## Voice

Speech to text stays local with Whisper. Microphone audio does not leave the host.
Text to speech uses ElevenLabs only when `ELEVENLABS_API_KEY` is set.
Then provisioning selects the model `eleven_multilingual_v2` and the premade voice Sarah (`EXAVITQu4vr4xnSDxMaL`).
Free ElevenLabs plans cannot use voice-library voices through the API, so the voice is a premade one.
ElevenLabs receives the reply text and can incur charges.

Open WebUI keeps audio settings in its database, and an environment variable does not change an existing volume.
For that reason, each provisioning run writes the text-to-speech settings through the admin API.
It writes nothing when the stored settings already match.
Without the key, provisioning does not change the audio settings.
A removed key does not clear a stored ElevenLabs setting. Change it in Admin Settings > Audio.

## Differences

| Area              | Previous repo host       | Companion workspace                          | Ported host                                  |
| ----------------- | ------------------------ | -------------------------------------------- | -------------------------------------------- |
| Presets           | Buyer agent              | Acme Kitchens and Bakery                     | Both Acme presets                            |
| Inference         | Configurable first model | Local Qwen through Ollama                    | Exact Verda Nemotron 3.5 Super VL            |
| Prompt            | Voice-only orders        | Planning and purchasing                      | Short orders; structured planning            |
| Ordering skill    | Embedded local text      | Imported native MCP skill                    | Main project's skill and references embedded |
| Recipe arithmetic | None                     | Bound only when recipe fetching is permitted | Always available                             |
| Recipe fetching   | None                     | Permission-gated                             | Permission-gated; off by default             |
| Local login       | Off                      | On                                           | On; existing default account migration       |
| Buyer voice       | Optional                 | Disabled by permissions                      | Available; ElevenLabs with its key           |
| Deployment        | Local and hosted         | Local Compose                                | Local Compose and hosted chat image          |

The port includes the workspace's two local commits through `b834c18`.
It excludes Ollama, model downloads, local Finnish speech auditions, caches and private configuration.
Branding uses the upstream custom stylesheet hook. Open WebUI identity and license notices remain intact.
Photograph credits are served at `/static/acme/credits.html`.

See [prompt checks](buyer-agent-prompt.md#test-sentences) and [hosted deployment](deploy.md#hosted-chat).

## Chat checks

`bun scripts/chat-check.ts` uses the same Compose-resolved operator credentials as setup.
It signs in through the browser and selects Acme Kitchens.
Use `--no-reset` for a read-only scenario that must preserve the worktree database.
The default scenarios can create orders and reset the local database.
