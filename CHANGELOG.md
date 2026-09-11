# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org).

## 0.1.0 — unreleased

Initial release.

- `upload_file(path, upload_url)` stdio MCP tool — PUT a local file to a short
  InstantStudio upload URL (from the remote `request_upload`); returns the durable
  `asset_ref`. Bytes never pass through the model.
- Zero runtime dependencies.
- Upload-target policy: https-only except `localhost` by default; pin hosts with
  `INSTANTSTUDIO_FILES_ALLOWED_HOSTS`.
- Bounded uploads: size cap (`INSTANTSTUDIO_FILES_MAX_BYTES`, default 25 MB to match
  the InstantStudio upload limit) and request timeout (`INSTANTSTUDIO_FILES_TIMEOUT_MS`).
