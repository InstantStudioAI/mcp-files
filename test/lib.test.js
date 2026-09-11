import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFile, guessMime, assertUploadUrlAllowed, hostAllowlistConfigured, ToolError } from "../src/lib.js";

async function withTempFile(bytes, name = "sample.png") {
  const dir = await mkdtemp(join(tmpdir(), "isf-"));
  const path = join(dir, name);
  await writeFile(path, bytes);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  })();
}

test("guessMime maps known extensions and returns null otherwise", () => {
  assert.equal(guessMime("/a/b.png"), "image/png");
  assert.equal(guessMime("/a/b.MP4"), "video/mp4");
  assert.equal(guessMime("/a/b.xyz"), null);
});

test("uploadFile PUTs the bytes and returns the server's asset_ref + byte count", async () => {
  const bytes = Buffer.from("some image bytes here");
  const captured = {};
  const server = createServer((req, res) => {
    captured.method = req.method;
    captured.ctype = req.headers["content-type"];
    captured.length = req.headers["content-length"];
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.body = Buffer.concat(chunks);
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ asset_ref: "H3N8VW2BK5QD", byte_size: bytes.length, mime_type: "image/png" }));
    });
  });
  const port = await listen(server);
  const { path, cleanup } = await withTempFile(bytes, "x.png");
  try {
    // 127.0.0.1 is localhost, so allowed over http without an allowlist.
    const r = await uploadFile(path, `http://127.0.0.1:${port}/u/ABCDEFGHJKMN`);
    assert.equal(r.ok, true);
    assert.equal(r.asset_ref, "H3N8VW2BK5QD");
    assert.equal(r.bytes, bytes.length);
    assert.equal(captured.method, "PUT");
    assert.equal(captured.ctype, "image/png");
    assert.equal(captured.length, String(bytes.length));
    assert.deepEqual(captured.body, bytes);
  } finally {
    await cleanup();
    server.close();
  }
});

test("uploadFile throws a ToolError carrying the status on a non-2xx response", async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 410;
    res.end('{"error":"slug_expired"}');
  });
  const port = await listen(server);
  const { path, cleanup } = await withTempFile(Buffer.from("x"), "x.png");
  try {
    await assert.rejects(() => uploadFile(path, `http://127.0.0.1:${port}/u/ABCDEFGHJKMN`), /410/);
  } finally {
    await cleanup();
    server.close();
  }
});

test("uploadFile requires an upload_url and an existing file", async () => {
  await assert.rejects(() => uploadFile("/tmp/whatever.png", ""), ToolError);
  await assert.rejects(() => uploadFile("/no/such/file.png", "https://ex.com/u/x"), ToolError);
});

test("uploadFile enforces the size cap before uploading", async () => {
  const { path, cleanup } = await withTempFile(Buffer.alloc(64), "big.png");
  try {
    await withEnv({ INSTANTSTUDIO_FILES_MAX_BYTES: "16" }, async () => {
      await assert.rejects(() => uploadFile(path, "http://127.0.0.1:1/u/ABCDEFGHJKMN"), /cap/);
    });
  } finally {
    await cleanup();
  }
});

test("uploadFile times out a stalled request", async () => {
  const server = createServer((req, _res) => {
    req.on("data", () => {});
    req.on("end", () => { /* never respond → force a timeout */ });
  });
  const port = await listen(server);
  const { path, cleanup } = await withTempFile(Buffer.from("x"), "x.png");
  try {
    await withEnv({ INSTANTSTUDIO_FILES_TIMEOUT_MS: "80" }, async () => {
      await assert.rejects(() => uploadFile(path, `http://127.0.0.1:${port}/u/ABCDEFGHJKMN`), /timed out/);
    });
  } finally {
    await cleanup();
    server.close();
  }
});

test("assertUploadUrlAllowed: https anywhere ok; http only for localhost; else refused", () => {
  assert.doesNotThrow(() => assertUploadUrlAllowed("https://toolkit.instantstudio.ai/u/x", ""));
  assert.doesNotThrow(() => assertUploadUrlAllowed("http://localhost:3000/u/x", ""));
  assert.doesNotThrow(() => assertUploadUrlAllowed("http://127.0.0.1:3000/u/x", ""));
  assert.throws(() => assertUploadUrlAllowed("http://evil.example/collect", ""), /non-https/);
  assert.throws(() => assertUploadUrlAllowed("not-a-url", ""), /Invalid upload_url/);
});

test("assertUploadUrlAllowed: an allowlist is the authority (matches by host / suffix)", () => {
  assert.doesNotThrow(() => assertUploadUrlAllowed("https://cdn.instantstudio.ai/u/x", "instantstudio.ai"));
  // allowlist lets even a non-https host through — the operator trusts it explicitly
  assert.doesNotThrow(() => assertUploadUrlAllowed("http://storage.internal/u/x", "storage.internal"));
  assert.throws(() => assertUploadUrlAllowed("https://evil.example/u/x", "instantstudio.ai"), /not in INSTANTSTUDIO_FILES_ALLOWED_HOSTS/);
});

test("hostAllowlistConfigured reflects the env", () => {
  assert.equal(hostAllowlistConfigured(""), false);
  assert.equal(hostAllowlistConfigured("  "), false);
  assert.equal(hostAllowlistConfigured("instantstudio.ai"), true);
});
