// Core file op for the instantstudio-files MCP helper. One job: PUT a local
// file's bytes to a short upload URL that request_upload handed the agent. Node
// built-ins only (no dependencies).
//
// Flow (docs/plans/mcp-file-ingress.md §12 in pawsome-ai-web):
//   (remote) request_upload(filename?)      -> { upload_url, expires_at }
//   upload_file(path, upload_url)            -> { ok, asset_ref, byte_size, mime_type }
//   (remote) use asset_ref in update_spec / run_app image slots
//
// The server derives size/checksum/type from the stream and returns a short
// `asset_ref` — so no long opaque string ever crosses the model boundary. Bytes
// never pass through the model.

import { stat, readFile } from "node:fs/promises";
import { extname } from "node:path";

// User-facing failures (bad path, rejected upload). Anything else is unexpected.
export class ToolError extends Error {}

// Defaults are read from env at call time so they can be tuned per deployment and
// exercised in tests.
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB — matches the InstantStudio upload limit; also bounds memory (we buffer the file)
const DEFAULT_TIMEOUT_MS = 120_000; // 2 min
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".heic": "image/heic", ".heif": "image/heif", ".svg": "image/svg+xml", ".avif": "image/avif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".flac": "audio/flac"
};

// Best-effort content type from the extension; sent only as a hint (the server
// sniffs the real type). null when unknown.
export function guessMime(path) {
  return MIME_BY_EXT[extname(String(path)).toLowerCase()] || null;
}

// True when no host allowlist is configured — used to emit a one-time hardening
// advisory at startup (see index.js).
export function hostAllowlistConfigured(allowedEnv = process.env.INSTANTSTUDIO_FILES_ALLOWED_HOSTS) {
  return String(allowedEnv || "").split(",").map((s) => s.trim()).filter(Boolean).length > 0;
}

// Guard against the helper being turned into a file-exfiltration primitive by an
// upload_url from an untrusted source. Policy:
//   * INSTANTSTUDIO_FILES_ALLOWED_HOSTS set  -> the host MUST match one of them
//     (the operator's explicit trust list is the authority; any scheme).
//   * otherwise                              -> require https, EXCEPT localhost
//     (dev over http). This blocks plain-http exfil targets; pin hosts with the
//     allowlist for stronger protection.
export function assertUploadUrlAllowed(uploadUrl, allowedEnv = process.env.INSTANTSTUDIO_FILES_ALLOWED_HOSTS) {
  let url;
  try {
    url = new URL(uploadUrl);
  } catch {
    throw new ToolError(`Invalid upload_url: ${uploadUrl}`);
  }

  const allow = String(allowedEnv || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length > 0) {
    const host = url.host;
    const ok = allow.some((a) => host === a || host.endsWith("." + a));
    if (!ok) throw new ToolError(`upload_url host ${host} is not in INSTANTSTUDIO_FILES_ALLOWED_HOSTS`);
    return;
  }

  if (url.protocol !== "https:" && !LOCAL_HOSTS.has(url.hostname)) {
    throw new ToolError(
      `Refusing to upload to a non-https, non-localhost URL (${url.protocol}//${url.host}). ` +
      "Set INSTANTSTUDIO_FILES_ALLOWED_HOSTS to allow it."
    );
  }
}

async function statFile(path) {
  if (typeof path !== "string" || !path) throw new ToolError("path is required");
  let st;
  try {
    st = await stat(path);
  } catch {
    throw new ToolError(`File not found: ${path}`);
  }
  if (!st.isFile()) throw new ToolError(`Not a regular file: ${path}`);
  return st;
}

// PUT the file to the short upload URL. No checksum, no required headers — the
// server derives everything from the stream. Returns the server's response
// (notably `asset_ref`) merged with the local byte count. Bounded by a size cap
// (we buffer the file) and a request timeout.
export async function uploadFile(path, uploadUrl) {
  if (typeof uploadUrl !== "string" || !uploadUrl) throw new ToolError("upload_url is required");
  const st = await statFile(path);
  assertUploadUrlAllowed(uploadUrl);

  const cap = envNumber("INSTANTSTUDIO_FILES_MAX_BYTES", DEFAULT_MAX_BYTES);
  if (st.size > cap) {
    throw new ToolError(
      `File is ${st.size} bytes; the local cap is ${cap} (set INSTANTSTUDIO_FILES_MAX_BYTES to change).`
    );
  }

  const body = await readFile(path);

  const controller = new AbortController();
  const timeout = envNumber("INSTANTSTUDIO_FILES_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": guessMime(path) || "application/octet-stream" }, // a hint only
      body,
      signal: controller.signal
    });
  } catch (e) {
    if (e?.name === "AbortError") throw new ToolError(`Upload timed out after ${timeout}ms`);
    throw new ToolError(`PUT request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* body may be empty */
    }
    throw new ToolError(`Upload rejected: HTTP ${res.status} ${res.statusText}${detail ? " — " + detail : ""}`);
  }

  let payload = {};
  try {
    payload = await res.json();
  } catch {
    /* server should return JSON, but don't fail the upload over a parse */
  }

  return { ok: true, bytes: st.size, ...payload };
}
