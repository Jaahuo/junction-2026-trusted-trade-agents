# Host support

This page collects notes for hosts that connect to the `/mcp` endpoint and for implementers who serve it.

## Skills extension

The repo serves one skill, `trusted-trade-ordering`, through the MCP Skills extension. The pinned spec is [Skills specification, beta](https://skills.extensions.modelcontextprotocol.io/specification/beta/skills) (SEP-2640, base protocol revision 2026-07-28 or later). The skill files are in `skills/trusted-trade-ordering/` (`SKILL.md`, `reason-codes.md`). The endpoint is `ALL /mcp`, stateless streamable HTTP (SPEC-012).

SPEC-012 describes the manifest as "(path, digest, size)". The pinned spec uses `uri` instead of `path`. The pinned spec wins.

### Capability declaration

The pinned spec puts the declaration in the `server/discover` result of protocol revision 2026-07-28. The server SDK (1.32.2) speaks only the `initialize` era (revisions up to 2025-11-25), and its HTTP transport answers a request with `MCP-Protocol-Version: 2026-07-28` with 400. This server therefore declares the extension in two places:

- the `initialize` result, in `capabilities.extensions`;
- a `server/discover` answer whose `supportedVersions` are the legacy versions the SDK speaks, not `2026-07-28`. A client on the 2026 revision falls back to `initialize`.

The value is `{}`. This repo does not implement `resources/directory/read`, so it does not set `directoryRead`. The server must also declare `resources`. The client declares no capability key. `skills/list`, `skills/get` and `resources/read` of the `skill://` URIs work on the legacy transport. The `skill://` files are read as a resource template, so `resources/list` lists only the `ui://` views.

```json
{
  "capabilities": {
    "resources": { "listChanged": true },
    "extensions": {
      "io.modelcontextprotocol/skills": {}
    }
  }
}
```

A 2026-07-28 client carries `params._meta` with `io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientInfo`, and `io.modelcontextprotocol/clientCapabilities` on every request. This server ignores them.

### Discovery methods

| Method        | Params                                              | Result                                                                           |
| ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `skills/list` | `cursor` (optional)                                 | `resultType`, `skills` (entries), `nextCursor` (optional), `ttlMs`, `cacheScope` |
| `skills/get`  | `uri`: the `skill://` URI of the skill's `SKILL.md` | `resultType`, `skill` (one entry), `ttlMs`, `cacheScope`                         |

`resultType` is `"complete"`. `ttlMs` and `cacheScope` tell the host how long and how widely it may cache the result. `skills/get` wraps the entry in `skill`.

### Entry shape

| Field         | Content                                             |
| ------------- | --------------------------------------------------- |
| `uri`         | `skill://trusted-trade-ordering/SKILL.md`           |
| `frontmatter` | `name`, `description`, and other frontmatter fields |
| `resources`   | File manifest (next section)                        |
| `_meta`       | Optional                                            |

### File manifest and file fetch

`resources` is an array of objects. It is complete and includes `SKILL.md` itself.

| Field    | Content                                 |
| -------- | --------------------------------------- |
| `uri`    | `skill://trusted-trade-ordering/<file>` |
| `digest` | `sha256:<64 lowercase hex characters>`  |
| `size`   | File size in bytes                      |

The manifest has no path and no MIME type. Limits: 512 entries, 16 MiB.

The host fetches each file with the standard `resources/read` method and the file's `uri`. The `SKILL.md` MIME type should be `text/markdown`.

```json
{
  "uri": "skill://trusted-trade-ordering/reason-codes.md",
  "digest": "sha256:<hex>",
  "size": 1234
}
```

The example is synthetic. The values are placeholders.

### Without the Skills extension

A host without the extension downloads the files over plain HTTP from the discovery context. Both URLs are relative to the public base URL:

- `/skills/trusted-trade-ordering/SKILL.md`
- `/skills/trusted-trade-ordering/reason-codes.md`

The responses are `text/markdown; charset=utf-8` attachments. Keep both files in one folder: `SKILL.md` links `reason-codes.md` by relative path.

```sh
mkdir -p trusted-trade-ordering
curl -fsS "$BASE_URL/skills/trusted-trade-ordering/SKILL.md" -o trusted-trade-ordering/SKILL.md
curl -fsS "$BASE_URL/skills/trusted-trade-ordering/reason-codes.md" -o trusted-trade-ordering/reason-codes.md
```

### Errors

| Code     | Cause          |
| -------- | -------------- |
| `-32602` | Unknown `uri`  |
| `-32603` | Internal error |

The spec defines no notifications.

## Open WebUI

Open WebUI is a self-hosted chat host. It is the proposed main demo host (docs/prd.md row "Demo hosts", decision #44).
This section records what Open WebUI documents, read on Nov 14, 2026.
These are vendor claims, not measured results.
The host spike #9 and the voice spike #45 record the measured result for each check.

### Version

Use Open WebUI v0.13.1 or later, and record the exact image tag in the spike result.

| Version | What it adds                                                                                                                  | Source                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| v0.6.31 | Native MCP support over Streamable HTTP                                                                                       | [MCP docs](https://docs.openwebui.com/features/extensibility/mcp/)             |
| v0.13.0 | MCP Apps in chat: a tool's app renders in a sandboxed frame, and each tool call from the app waits for the user to confirm it | [release notes](https://github.com/open-webui/open-webui/releases/tag/v0.13.0) |
| v0.13.1 | MCP App views keep their state while the message updates; an app can send a chat message after the user confirms it           | [release notes](https://github.com/open-webui/open-webui/releases/tag/v0.13.1) |

A version before v0.13.0 shows only the text and structured result of a tool, not the view.

### Documented behavior

| Check (#9)        | Open WebUI documents                                                                                                                           | Effect on this server                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| no-auth connector | Native MCP is Streamable HTTP only. An administrator adds the server. The connection auth can be None.                                         | Add `<base URL>/mcp` with auth None (SPEC-012). Stdio and SSE are not needed.         |
| views render      | A tool whose `_meta.ui.resourceUri` points to a `ui://` resource of type `text/html;profile=mcp-app` renders inline after it runs. Limit 5 MB. | The server already serves its views with this MIME type.                              |
| view calls tool   | An app can call the server's tools. The user confirms each call in a "Tool call" dialog.                                                       | Approve and reject from the approval card take one extra click to confirm.            |
| app-only hidden   | `_meta.ui.visibility` is honored: a tool without `model` is hidden from the model, and a tool without `app` cannot be called by an app.        | Keep `MCP_VIEW_TOOLS=app`, the default. The view tools declare `visibility: ["app"]`. |
| token round trip  | Not documented.                                                                                                                                | Measure in the spike.                                                                 |

Open WebUI needs a stable `WEBUI_SECRET_KEY` for MCP Apps.
Set it in the container environment so that a restart does not change it.

The app frame can reach only the sites that the server declares.
Inside a host, the views call tools through the MCP Apps bridge and do not fetch the REST API directly (`contexts/views/src/shared/source.ts`), so they need no extra domains.

### Measured results

#9 owns the result lines in this file (its acceptance 7 counts exactly five `<check>: yes|no` lines).
When #9 runs in Open WebUI, those lines name Open WebUI and its image tag as the host.
The voice spike #45 posts its results on #44.
