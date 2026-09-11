import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../src/index.js", import.meta.url));

// Drives the real stdio server over a JSON-RPC session, PUTting to a local sink.
test("stdio server: initialize, tools/list, tools/call, errors", async () => {
  const captured = {};
  const sink = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.method = req.method;
      captured.body = Buffer.concat(chunks);
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ asset_ref: "H3N8VW2BK5QD", byte_size: captured.body.length, mime_type: "image/png" }));
    });
  });
  const port = await new Promise((r) => sink.listen(0, () => r(sink.address().port)));

  const bytes = Buffer.from("server test bytes \u{1F680}");
  const dir = await mkdtemp(join(tmpdir(), "isf-server-"));
  const path = join(dir, "photo.png");
  await writeFile(path, bytes);

  const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "ignore"] });
  const responses = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });

  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const waitFor = (id) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const t = setInterval(() => {
        const r = responses.find((x) => x.id === id);
        if (r) { clearInterval(t); resolve(r); }
        else if (Date.now() - started > 5000) { clearInterval(t); reject(new Error(`timeout waiting for id ${id}`)); }
      }, 10);
    });

  try {
    // initialize
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    const init = await waitFor(1);
    assert.equal(init.result.serverInfo.name, "instantstudio-files");
    assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);

    // notifications get no reply
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // tools/list
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await waitFor(2);
    assert.deepEqual(list.result.tools.map((t) => t.name), ["upload_file"]);

    // tools/call — happy path
    send({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "upload_file", arguments: { path, upload_url: `http://127.0.0.1:${port}/u/ABCDEFGHJKMN` } }
    });
    const uploaded = await waitFor(3);
    assert.equal(uploaded.result.isError, false);
    assert.equal(uploaded.result.structuredContent.asset_ref, "H3N8VW2BK5QD");
    assert.equal(captured.method, "PUT");
    assert.deepEqual(captured.body, bytes);

    // tools/call — tool error is result-level (isError), not a protocol error
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "upload_file", arguments: { path: "/no/such.png", upload_url: `http://127.0.0.1:${port}/u/x` } } });
    const err = await waitFor(4);
    assert.equal(err.result.isError, true);
    assert.match(err.result.content[0].text, /File not found/);

    // unknown method → JSON-RPC error
    send({ jsonrpc: "2.0", id: 5, method: "does/not/exist" });
    const unknown = await waitFor(5);
    assert.equal(unknown.error.code, -32601);

    // the notification produced no id-less response
    assert.equal(responses.filter((r) => r.id === undefined).length, 0);
  } finally {
    child.kill();
    sink.close();
    await rm(dir, { recursive: true, force: true });
  }
});
