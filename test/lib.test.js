import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hashFile, uploadFile, guessMime, checkHostAllowed, ToolError } from "../src/lib.js";

async function withTempFile(bytes, name = "sample.png") {
  const dir = await mkdtemp(join(tmpdir(), "isf-"));
  const path = join(dir, name);
  await writeFile(path, bytes);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

test("hashFile returns size, base64 MD5, sha256, filename and mime", async () => {
  const bytes = Buffer.from("hello world");
  const { path, cleanup } = await withTempFile(bytes, "pic.JPG");
  try {
    const r = await hashFile(path);
    assert.equal(r.byte_size, bytes.length);
    assert.equal(r.checksum, createHash("md5").update(bytes).digest("base64"));
    assert.equal(r.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(r.mime_type, "image/jpeg"); // extension match is case-insensitive
    assert.equal(r.filename, "pic.JPG");
  } finally {
    await cleanup();
  }
});

test("guessMime maps known extensions and returns null otherwise", () => {
  assert.equal(guessMime("/a/b.png"), "image/png");
  assert.equal(guessMime("/a/b.MP4"), "video/mp4");
  assert.equal(guessMime("/a/b.xyz"), null);
});

test("hashFile rejects a missing file with a ToolError", async () => {
  await assert.rejects(() => hashFile("/no/such/file.png"), ToolError);
});

test("uploadFile PUTs the bytes with forwarded headers and reports ok", async () => {
  const bytes = Buffer.from("some image bytes here");
  const captured = {};
  const server = createServer((req, res) => {
    captured.method = req.method;
    captured.ctype = req.headers["content-type"];
    captured.md5 = req.headers["content-md5"];
    captured.length = req.headers["content-length"];
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.body = Buffer.concat(chunks);
      res.statusCode = 200;
      res.end("ok");
    });
  });
  const port = await listen(server);
  const { path, cleanup } = await withTempFile(bytes, "x.png");
  try {
    const md5 = createHash("md5").update(bytes).digest("base64");
    const r = await uploadFile(path, `http://127.0.0.1:${port}/blob`, {
      "Content-Type": "image/png",
      "Content-MD5": md5
    });
    assert.equal(r.ok, true);
    assert.equal(r.bytes, bytes.length);
    assert.equal(r.status, 200);
    assert.equal(captured.method, "PUT");
    assert.equal(captured.ctype, "image/png");
    assert.equal(captured.md5, md5);
    assert.equal(captured.length, String(bytes.length)); // exact Content-Length, no chunked
    assert.deepEqual(captured.body, bytes);
  } finally {
    await cleanup();
    server.close();
  }
});

test("uploadFile throws a ToolError carrying the status on a non-2xx response", async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 403;
    res.end("SignatureDoesNotMatch");
  });
  const port = await listen(server);
  const { path, cleanup } = await withTempFile(Buffer.from("x"), "x.png");
  try {
    await assert.rejects(() => uploadFile(path, `http://127.0.0.1:${port}/blob`, {}), /403/);
  } finally {
    await cleanup();
    server.close();
  }
});

test("uploadFile requires a put_url and an existing file", async () => {
  await assert.rejects(() => uploadFile("/tmp/whatever.png", ""), ToolError);
  await assert.rejects(() => uploadFile("/no/such/file.png", "http://127.0.0.1:1/x"), ToolError);
});

test("checkHostAllowed enforces an allowlist only when configured", () => {
  assert.throws(() => checkHostAllowed("https://evil.example/x", "storage.instantstudio.ai"), ToolError);
  assert.doesNotThrow(() => checkHostAllowed("https://f005.backblazeb2.com/x", "backblazeb2.com"));
  assert.doesNotThrow(() => checkHostAllowed("https://anything.example/x", "")); // unset = allow any
});
