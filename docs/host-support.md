# Host support

This page collects notes for hosts that connect to the `/mcp` endpoint and for implementers who serve it.

## Skills extension

The repo serves one skill, `trusted-trade-ordering`, through the MCP Skills extension. The pinned spec is [Skills specification, beta](https://skills.extensions.modelcontextprotocol.io/specification/beta/skills) (SEP-2640, base protocol revision 2026-07-28 or later). The skill files are in `skills/trusted-trade-ordering/` (`SKILL.md`, `reason-codes.md`). The endpoint is `ALL /mcp`, stateless streamable HTTP (SPEC-012).

SPEC-012 describes the manifest as "(path, digest, size)". The pinned spec uses `uri` instead of `path`. The pinned spec wins.

### Capability declaration

The server declares the extension in `capabilities.extensions` of the `server/discover` result, not in `initialize`. The value is `{}`. This repo does not implement `resources/directory/read`, so it does not set `directoryRead`. The server must also declare `resources`. The client declares no capability key.

```json
{
  "capabilities": {
    "resources": {},
    "extensions": {
      "io.modelcontextprotocol/skills": {}
    }
  }
}
```

Every request carries `params._meta` with `io.modelcontextprotocol/protocolVersion` (`"2026-07-28"`), `io.modelcontextprotocol/clientInfo`, and `io.modelcontextprotocol/clientCapabilities`.

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

### Errors

| Code     | Cause          |
| -------- | -------------- |
| `-32602` | Unknown `uri`  |
| `-32603` | Internal error |

The spec defines no notifications.
