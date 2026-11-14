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
