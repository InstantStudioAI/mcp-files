# @instantstudio/mcp-files

A tiny **local** MCP server that lets an agent send a file from the user's disk to
InstantStudio. It runs on the user's machine — the one place with filesystem
access — and gives the agent two tools: **hash a local file**, and **PUT its bytes
to a presigned URL**. The bytes go straight to storage; they never pass through the
model or the MCP channel.

It is the local half of InstantStudio's file-ingress flow. The remote InstantStudio
MCP server (`instantstudio-remote`) mints the presigned upload and holds all the
auth; this helper just hashes and uploads. It stores **no credentials** and needs
**no config**.

Zero dependencies (Node built-ins only), so it is auditable and cold-starts fast
under `npx`.

## The flow

```
hash_file(path)                       -> { filename, byte_size, checksum, sha256, mime_type }
request_upload(byte_size, checksum,   -> { put_url, headers, signed_id, ... }   [remote tool]
               filename, mime_type)
upload_file(path, put_url, headers)   -> { ok, bytes, status }
attach_asset(signed_id)               -> use the file in a generation           [remote tool]
```

`hash_file` comes **first**: the remote `request_upload` needs the file's exact
`byte_size` and `checksum` (base64 MD5) to mint an upload URL the object store pins
to that size and digest. `upload_file` then PUTs the bytes with the headers the
server returned. The agent orchestrates the four calls; only `upload_file` moves
bytes, and only to storage.

## Requirements

Node.js **18+** (uses the built-in `fetch`, `node:test`, `fs/promises`, `crypto`).

## Install / configure

`npx` fetches and runs it on demand — there is no separate install step. Add it as a
**second** MCP server alongside the InstantStudio remote server in your client's MCP
config, then reconnect.

```json
{
  "mcpServers": {
    "instantstudio-remote": {
      "type": "http",
      "url": "https://toolkit.instantstudio.ai/mcp"
    },
    "instantstudio-files": {
      "command": "npx",
      "args": ["-y", "@instantstudio/mcp-files@0.1.0"]
    }
  }
}
```

Pin the version (`@0.1.0`) so an install can't be surprised by a new release.

Config file locations vary by client — e.g. `~/.cursor/mcp.json` (Cursor), the
workspace/user `mcp.json` (VS Code), `~/.codex/config.toml` (Codex CLI). For Claude
(Cowork / Desktop / Code) the InstantStudio plugin bundles this server, so no manual
config is needed.

## Tools

### `hash_file(path)`
Compute a local file's `{ filename, byte_size, checksum (base64 MD5), sha256,
mime_type }`. Streams the file, so memory stays flat regardless of size. Call it
before `request_upload`.

### `upload_file(path, put_url, headers)`
PUT the file's bytes to `put_url`, forwarding `headers` verbatim (they carry the
`Content-Type` / `Content-MD5` the store verifies; the body sets `Content-Length`).
Returns `{ ok, bytes, status }`, or an error carrying the store's HTTP status on
rejection.

## Security

- **No credentials, no config.** The authority lives entirely in the presigned
  `put_url`, which comes from the trusted InstantStudio server via the agent.
- **Trust the source of `put_url`.** This helper will PUT a local file to whatever
  URL it is handed. Use it only with the InstantStudio remote server. For defense in
  depth, set `INSTANTSTUDIO_FILES_ALLOWED_HOSTS` (comma-separated hosts) to refuse
  PUTs to anywhere else — e.g. `INSTANTSTUDIO_FILES_ALLOWED_HOSTS=backblazeb2.com,s3.amazonaws.com`.
- **Pin the version** in your MCP config, and let your client prompt before running
  it rather than auto-executing.

## Develop

```bash
npm test          # node --test, zero-dependency
npm start         # run the stdio server directly (it reads JSON-RPC on stdin)
```
