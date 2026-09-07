// Core file operations for the instantstudio-files MCP helper. Pure functions,
// Node built-ins only (no dependencies), so the whole package is auditable and
// npx-cold-starts instantly. The MCP/stdio wiring lives in index.js.
//
// Flow this supports (docs/plans/mcp-file-ingress.md in pawsome-ai-web):
//   hash_file(path)                        -> { byte_size, checksum, ... }
//   (remote) request_upload(byte_size, checksum, ...) -> { put_url, headers, signed_id }
//   upload_file(path, put_url, headers)    -> PUT the bytes to storage
//   (remote) attach_asset(signed_id)       -> use it in a generation
//
// The checksum (base64 MD5) MUST be computed here, BEFORE request_upload, because
// the server mints the presigned URL pinned to that exact MD5 + byte size. Bytes
// never pass through the model or the MCP channel — only the PUT carries them.

import { stat, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";

// User-facing failures (bad path, rejected upload). Anything else is unexpected.
export class ToolError extends Error {}

const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".heic": "image/heic", ".heif": "image/heif", ".svg": "image/svg+xml", ".avif": "image/avif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".flac": "audio/flac"
};

// Best-effort content type from the extension; null when unknown (the caller can
// still upload — request_upload's mime_type is optional).
export function guessMime(path) {
  return MIME_BY_EXT[extname(String(path)).toLowerCase()] || null;
}

// Optional hardening: if INSTANTSTUDIO_FILES_ALLOWED_HOSTS is set (comma-separated
// hosts), refuse to PUT anywhere else. Guards against a put_url from an untrusted
// source turning the helper into a file-exfiltration primitive. Unset = allow any
// (the put_url is expected to come from the trusted InstantStudio server).
export function checkHostAllowed(putUrl, allowedEnv = process.env.INSTANTSTUDIO_FILES_ALLOWED_HOSTS) {
  const allow = String(allowedEnv || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return;

  let host;
  try {
    host = new URL(putUrl).host;
  } catch {
    throw new ToolError(`Invalid put_url: ${putUrl}`);
  }
  const ok = allow.some((a) => host === a || host.endsWith("." + a));
  if (!ok) throw new ToolError(`put_url host ${host} is not in INSTANTSTUDIO_FILES_ALLOWED_HOSTS`);
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

// Compute the metadata request_upload needs. Streams the file so it never holds
// more than a chunk in memory while hashing.
export async function hashFile(path) {
  const st = await statFile(path);
  const md5 = createHash("md5");
  const sha = createHash("sha256");

  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      md5.update(chunk);
      sha.update(chunk);
    });
    stream.on("end", resolve);
    stream.on("error", (e) => reject(new ToolError(`Could not read ${path}: ${e.message}`)));
  });

  return {
    filename: basename(path),
    byte_size: st.size,
    checksum: md5.digest("base64"), // base64 MD5 — exactly what request_upload's `checksum` wants
    sha256: sha.digest("hex"),
    mime_type: guessMime(path)
  };
}

// PUT the file's bytes to the presigned url, forwarding the server's headers
// verbatim (they carry Content-Type / Content-MD5 the store verifies; the body
// Buffer sets Content-Length). Bounded by the server's already-enforced size cap,
// so a full read is fine here.
export async function uploadFile(path, putUrl, headers) {
  if (typeof putUrl !== "string" || !putUrl) throw new ToolError("put_url is required");
  const st = await statFile(path);
  checkHostAllowed(putUrl);

  const body = await readFile(path);

  let res;
  try {
    res = await fetch(putUrl, {
      method: "PUT",
      headers: headers && typeof headers === "object" ? headers : {},
      body
    });
  } catch (e) {
    throw new ToolError(`PUT request failed: ${e.message}`);
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

  return { ok: true, bytes: st.size, status: res.status };
}
