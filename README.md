# @instantstudio/mcp-files

[![npm](https://img.shields.io/npm/v/@instantstudio/mcp-files)](https://www.npmjs.com/package/@instantstudio/mcp-files)
[![node](https://img.shields.io/node/v/@instantstudio/mcp-files)](https://nodejs.org)
[![license: MIT](https://img.shields.io/npm/l/@instantstudio/mcp-files)](./LICENSE)

A tiny **local** MCP server that lets an agent send a file from the user's disk to
InstantStudio. It runs on the user's machine — the one place with filesystem access —
and gives the agent a single tool: **PUT a local file to a short upload URL**. The
bytes go straight to the server; they never pass through the model or the MCP channel.

It is the local half of InstantStudio's file-ingress flow. The remote InstantStudio
MCP server mints a short, single-use `upload_url` and holds
all the auth; this helper just streams the file there. It stores **no credentials** and
needs **no config**.

Zero dependencies (Node built-ins only), so it is auditable and cold-starts fast
under `npx`.

## The flow

```
asset_upload(filename?)               -> { upload_url, lookup_url, expires_at }  [remote tool]
upload_file(path, upload_url, lookup_url?) -> { asset_id, byte_size, mime_type }
use asset_id in image slots or canvas fields                             [remote tools]
```

The server derives size, checksum, and content type from the uploaded stream and
returns the upload's **`asset_id`**, the durable handle the agent uses afterwards in
image slots (`app_run`, the typed app tools, `draft_update`) and canvas fields. No
hashing, no checksums, no headers to manage on the agent's side. The server's
response is passed through as it is.

### Duplicate preflight

When `asset_upload` also returned a `lookup_url`, pass it along: the helper hashes
the file locally (base64 MD5 — the same value the server derives from the stream)
and asks `GET /u/:slug/lookup` whether this team already holds those bytes before
spending bandwidth on the PUT.

- **Hit (200)** — the existing `asset_id` comes back (`reused: true`) and nothing
  is uploaded.
- **Miss (404)** — the lookup only peeks (it doesn't consume the slug), so the
  PUT proceeds as usual.
- **`400`/`410`** — the slug itself is malformed or expired: the tool fails and
  the agent should call `asset_upload` again for a fresh pair of URLs.
- **Any other lookup failure** — best-effort: the PUT runs anyway. The preflight
  is an optimization, never the authority — the server still derives
  size/checksum/type from the stream whenever bytes do travel.

## Requirements

Node.js **18+** (built-in `fetch`, `node:test`).

## Install / configure

`npx` fetches and runs it on demand — no separate install step. Add it as a **second**
MCP server alongside the InstantStudio remote server, then reconnect.

```json
{
  "mcpServers": {
    "instantstudio": {
      "type": "http",
      "url": "https://toolkit.instantstudio.ai/mcp"
    },
    "instantstudio-files": {
      "command": "npx",
      "args": ["-y", "@instantstudio/mcp-files@0.3.0"]
    }
  }
}
```

Pin the version so an install can't be surprised by a new release. Config file
locations vary by client (e.g. `~/.cursor/mcp.json`, the VS Code `mcp.json`,
`~/.codex/config.toml`). A batteries-included bundle that ships this helper alongside the
InstantStudio remote server is planned; until then, add the two entries above manually.

## Tool

### `upload_file(path, upload_url, lookup_url?)`
PUT the local file at `path` to the `upload_url` from `asset_upload`. Sends the
file's extension-guessed `Content-Type` as a hint (the server sniffs the real type).
Returns `{ ok, bytes, asset_id, byte_size, mime_type }`, or a `ToolError` carrying the
server's HTTP status on rejection (e.g. `410` = the upload_url expired → call
`asset_upload` again).

With the optional `lookup_url` (from `asset_upload`), the duplicate preflight
described above runs first: a hit returns the existing `asset_id` with
`reused: true` and skips the PUT entirely.

## Environment variables

All optional:

| Variable | Default | Purpose |
|---|---|---|
| `INSTANTSTUDIO_FILES_ALLOWED_HOSTS` | *(unset)* | Comma-separated host allowlist. When set, only these hosts may receive an upload (matched by host or `.suffix`), and it becomes the authority. |
| `INSTANTSTUDIO_FILES_MAX_BYTES` | `26214400` (25 MB) | Reject files larger than this — matches the InstantStudio upload limit (the file is buffered in memory). |
| `INSTANTSTUDIO_FILES_TIMEOUT_MS` | `120000` | Abort a PUT that stalls longer than this. |

## Security

- **No credentials, no config.** The authority lives in the short-lived `upload_url`,
  which comes from the trusted InstantStudio server via the agent.
- **Upload-target policy.** This helper PUTs a local file to the URL it's handed, so by
  default it **refuses any non-`https` URL except `localhost`** (dev) — blocking
  plain-http exfiltration targets. For stronger protection, pin the allowed host(s) with
  `INSTANTSTUDIO_FILES_ALLOWED_HOSTS`; when set, only those hosts are allowed. Use the
  helper only with the InstantStudio remote server. The same policy governs the
  `lookup_url`, and the preflight sends only the file's checksum and byte size — never
  the bytes.
- **Bounded.** Uploads are size-capped and time out (see the table above), so a bad path
  or a stalled endpoint can't exhaust memory or hang the agent.
- **Zero dependencies** — nothing transitive to audit.
- **Provenance.** Releases are published from CI with npm provenance; verify with
  `npm audit signatures` after install, or check the provenance badge on npm.
- **Pin the version** in your MCP config, and let your client prompt before running it.

## Develop

```bash
npm test          # node --test, zero-dependency
npm start         # run the stdio server (reads JSON-RPC on stdin)
```
