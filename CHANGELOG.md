# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org).

## 0.3.0 — 2026-11-26

- `upload_file` takes an optional **`lookup_url`** (the remote `asset_upload` now
  returns one alongside `upload_url`). The helper then preflights against
  `GET /u/:slug/lookup` (Uploads::Lookup): it hashes the exact bytes it would PUT
  (base64 MD5 — the value ActiveStorage stores) plus the byte size and asks whether
  this team already holds them. A hit returns the existing `asset_id` (`reused:
  true`) and skips the PUT; a 404 miss only peeks, leaving the slug intact for the
  PUT; 400/410 mean the slug is dead, so the tool fails fast (no doomed PUT) and
  points at re-minting with `asset_upload`; any other lookup failure is
  best-effort and the PUT runs anyway. The `lookup_url` sits under the same URL
  policy as the `upload_url` (`INSTANTSTUDIO_FILES_ALLOWED_HOSTS` / https-or-localhost).
- The size cap defaults to **100 MB** (`104857600`), up from 25 MB, to match the
  InstantStudio upload limit, which now reads the platform's
  `max_upload_file_size_mb` (100 MB by default) so a finished 1080P video can be
  uploaded. `INSTANTSTUDIO_FILES_MAX_BYTES` still overrides it.
- The request timeout defaults to **10 minutes**, up from 2. It covers the whole
  PUT, so the old value aborted healthy 100 MB uploads on a slow connection.
  `INSTANTSTUDIO_FILES_TIMEOUT_MS` still overrides it; the README now says it is a
  total, not a stall, timeout. The duplicate preflight is a small GET, so it waits
  at most 30 seconds (or the configured timeout, when that is shorter) before the
  PUT goes ahead.

## 0.2.0 — 2026-10-27

- `upload_file` returns the upload's **`asset_id`** (its uuid), the one file handle
  the InstantStudio remote tools take; the server retired the 12-character
  `asset_ref` on 2026-10-27. The tool still passes the server's response through as
  it is, so 0.1.0 keeps working: this release corrects the tool description, README
  and tests, which promised `asset_ref`.
- Names the current remote tools (`asset_upload`, `app_run`, `draft_update`, the
  typed app tools, canvas fields) instead of the names they had before 2026-09-28
  (`request_upload`, `update_spec`, `run_app`).

## 0.1.0 — 2026-09-14

Initial release.

- `upload_file(path, upload_url)` stdio MCP tool — PUT a local file to a short
  InstantStudio upload URL (from the remote `request_upload`); returns the durable
  `asset_ref`. Bytes never pass through the model.
- Zero runtime dependencies.
- Upload-target policy: https-only except `localhost` by default; pin hosts with
  `INSTANTSTUDIO_FILES_ALLOWED_HOSTS`.
- Bounded uploads: size cap (`INSTANTSTUDIO_FILES_MAX_BYTES`, default 25 MB to match
  the InstantStudio upload limit) and request timeout (`INSTANTSTUDIO_FILES_TIMEOUT_MS`).
