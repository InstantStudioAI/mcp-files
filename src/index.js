#!/usr/bin/env node
// instantstudio-files — a local stdio MCP server exposing ONE tool, upload_file:
// PUT a local file's bytes to a short upload URL that the remote InstantStudio
// MCP server minted (via request_upload). It runs on the user's machine (the one
// place with filesystem access) so files on disk reach InstantStudio without
// their bytes passing through the model or the MCP channel. It holds NO
// credentials and needs NO config: the upload_url carries all the authority.
//
// Deliberately zero-dependency: the MCP stdio transport is newline-delimited
// JSON-RPC 2.0, and the surface we need (initialize / tools/list / tools/call /
// ping) is small and stable. Keeping the dependency tree empty keeps this
// npx-distributed, filesystem-touching helper auditable and its cold start fast.

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { uploadFile, hostAllowlistConfigured, ToolError } from "./lib.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const SERVER_INFO = { name: "instantstudio-files", version };
// Echoed back to the client on initialize; used only if the client omits its own.
const FALLBACK_PROTOCOL = "2025-06-18";

// One-time hardening advisory (stderr only — never the protocol channel on stdout).
if (!hostAllowlistConfigured()) {
  process.stderr.write(
    "[instantstudio-files] no INSTANTSTUDIO_FILES_ALLOWED_HOSTS set — uploading only to https URLs (or " +
    "localhost). Set it to pin the allowed upload host(s) for stronger protection.\n"
  );
}

const TOOLS = [
  {
    name: "upload_file",
    description:
      "Upload a LOCAL file to InstantStudio: PUT its bytes to the `upload_url` that request_upload returned. " +
      "Returns { asset_ref, byte_size, mime_type } — `asset_ref` is a short handle; put it into update_spec / " +
      "run_app image slots. No hashing or headers needed; the server derives size/type from the bytes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the local file to upload." },
        upload_url: { type: "string", description: "The upload_url from request_upload." }
      },
      required: ["path", "upload_url"]
    }
  }
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function runTool(name, args) {
  switch (name) {
    case "upload_file":
      return uploadFile(args?.path, args?.upload_url);
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

async function handleToolCall(id, params) {
  try {
    const result = await runTool(params?.name, params?.arguments || {});
    // MCP tool results are result-level; a tool failure is isError:true, not a
    // JSON-RPC error.
    reply(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false
    });
  } catch (e) {
    const isExpected = e instanceof ToolError;
    if (!isExpected) process.stderr.write(`[instantstudio-files] ${e?.stack || e}\n`);
    reply(id, {
      content: [{ type: "text", text: isExpected ? e.message : "The tool failed to execute." }],
      isError: true
    });
  }
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call":
      return handleToolCall(id, params);
    default:
      // Notifications (no id, e.g. notifications/initialized) get no response;
      // unknown requests get a JSON-RPC "method not found".
      if (method?.startsWith("notifications/")) return;
      if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // ignore anything that isn't a JSON-RPC line
  }

  Promise.resolve(handle(message)).catch((e) => {
    process.stderr.write(`[instantstudio-files] handler error: ${e?.stack || e}\n`);
  });
});

// Observability only — does NOT change behavior. A stdio MCP server is shut down
// by the client closing its stdin (the spec's terminate signal), at which point
// this process exits once any in-flight call drains. We log that transition so a
// teardown is unambiguous in the client's captured stderr (e.g. mcp-stderr.log)
// instead of looking like a silent death. No process.exit(): letting the loop
// drain naturally preserves completion of an upload that was in flight at EOF.
rl.on("close", () => {
  process.stderr.write("[instantstudio-files] stdin closed by client; exiting after any in-flight call drains\n");
});
