#!/usr/bin/env node
// instantstudio-files — a local stdio MCP server that gives an agent two tools:
// hash a local file, and PUT its bytes to a presigned URL. It runs on the user's
// machine (the one place with filesystem access) so files that live on disk can
// reach InstantStudio without their bytes passing through the model or the MCP
// channel. It holds NO credentials and needs NO config: the put_url minted by the
// remote InstantStudio MCP server carries all the authority.
//
// Deliberately zero-dependency: the MCP stdio transport is newline-delimited
// JSON-RPC 2.0, and the surface we need (initialize / tools/list / tools/call /
// ping) is small and stable. Keeping the dependency tree empty keeps this
// npx-distributed, filesystem-touching helper auditable and its cold start fast.

import { createInterface } from "node:readline";
import { hashFile, uploadFile, ToolError } from "./lib.js";

const SERVER_INFO = { name: "instantstudio-files", version: "0.1.0" };
// Echoed back to the client on initialize; used only if the client omits its own.
const FALLBACK_PROTOCOL = "2025-06-18";

const TOOLS = [
  {
    name: "hash_file",
    description:
      "Compute a LOCAL file's size and checksum so you can call the remote request_upload tool. Returns " +
      "{ filename, byte_size, checksum (base64 MD5), sha256, mime_type }. Call this FIRST for a local file: " +
      "request_upload needs byte_size and checksum (and takes filename/mime_type) to mint the presigned upload.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the local file." }
      },
      required: ["path"]
    }
  },
  {
    name: "upload_file",
    description:
      "PUT a LOCAL file's bytes to a presigned put_url returned by request_upload, sending its headers verbatim " +
      "(they carry Content-Type / Content-MD5 the store verifies). Returns { ok, bytes, status }. On success, " +
      "call attach_asset(signed_id:) with the signed_id from request_upload to use the file in a generation.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the local file (the same one you hashed)." },
        put_url: { type: "string", description: "The presigned PUT url from request_upload." },
        headers: {
          type: "object",
          description: "The headers object from request_upload; forward every entry verbatim on the PUT."
        }
      },
      required: ["path", "put_url"]
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
    case "hash_file":
      return hashFile(args?.path);
    case "upload_file":
      return uploadFile(args?.path, args?.put_url, args?.headers);
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
