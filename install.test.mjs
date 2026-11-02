// node --test action/pqdoctor/install.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the right asset per runner", async () => {
  const { assetFor } = await import("./install.mjs");
  assert.equal(assetFor("0.3.0", "linux", "x64").file, "pqdoctor-0.3.0-linux-x64.tar.gz");
  assert.equal(assetFor("0.3.0", "linux", "arm64").bin, "pqdoctor-0.3.0-linux-arm64/pqdoctor");
  assert.equal(assetFor("0.3.0", "darwin", "arm64").file, "pqdoctor-0.3.0-macos-universal.tar.gz");
  assert.equal(assetFor("0.3.0", "win32", "x64").file, "pqdoctor-0.3.0-windows-x64.exe");
  assert.throws(() => assetFor("0.3.0", "aix", "ppc64"));
});

test("SHA256SUMS lines", async () => {
  const { sumFor } = await import("./install.mjs");
  const s = `${"a".repeat(64)}  pqdoctor-0.3.0-linux-x64.tar.gz\n${"B".repeat(64)} *pqdoctor-0.3.0-windows-x64.exe\n`;
  assert.equal(sumFor(s, "pqdoctor-0.3.0-windows-x64.exe"), "b".repeat(64));
  assert.equal(sumFor(s, "missing"), null);
});

test("sources: this repository's release first, then pqdoctor.com", async () => {
  const saved = process.env.PQDOCTOR_DOWNLOAD_BASE;
  delete process.env.PQDOCTOR_DOWNLOAD_BASE;
  const { basesFor } = await import("./install.mjs");
  assert.deepEqual(basesFor("0.4.0"), [
    "https://github.com/Kalyan-Deva/pqdoctor-action/releases/download/pqdoctor-v0.4.0",
    "https://pqdoctor.com/downloads/v0.4.0",
  ]);
  process.env.PQDOCTOR_DOWNLOAD_BASE = "http://a, http://b";
  assert.deepEqual(basesFor("1.0.0"), ["http://a/v1.0.0", "http://b/v1.0.0"]);
  if (saved === undefined) delete process.env.PQDOCTOR_DOWNLOAD_BASE;
  else process.env.PQDOCTOR_DOWNLOAD_BASE = saved;
});

test("a source that refuses (403) falls through to the next", async () => {
  const good = Buffer.from("pretend binary");
  const file = (await import("./install.mjs")).assetFor("7.7.7").file;
  const sums = `${createHash("sha256").update(good).digest("hex")}  ${file}\n`;
  const refuse = createServer((req, res) => {
    res.statusCode = 403;
    res.end();
  });
  const serve = createServer((req, res) => {
    if (req.url.endsWith("/SHA256SUMS.txt")) return res.end(sums);
    if (req.url.endsWith(`/${file}`)) return res.end(good);
    res.statusCode = 404;
    res.end();
  });
  await Promise.all([refuse, serve].map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))));
  const saved = process.env.PQDOCTOR_DOWNLOAD_BASE;
  process.env.PQDOCTOR_DOWNLOAD_BASE = `http://127.0.0.1:${refuse.address().port},http://127.0.0.1:${serve.address().port}`;
  const { install } = await import(`./install.mjs?fallback=${Date.now()}`);
  try {
    if (file.endsWith(".exe")) {
      const bin = await install("7.7.7", mkdtempSync(join(tmpdir(), "pqa-")));
      assert.deepEqual(readFileSync(bin), good);
    }
    process.env.PQDOCTOR_DOWNLOAD_BASE = `http://127.0.0.1:${refuse.address().port}`;
    await assert.rejects(install("7.7.7", mkdtempSync(join(tmpdir(), "pqa-"))), /couldn't download .*HTTP 403/);
  } finally {
    refuse.close();
    serve.close();
    if (saved === undefined) delete process.env.PQDOCTOR_DOWNLOAD_BASE;
    else process.env.PQDOCTOR_DOWNLOAD_BASE = saved;
  }
});

test("installs only what matches the published checksum", async () => {
  const good = Buffer.from("pretend binary");
  let serve = good;
  const file = (await import("./install.mjs")).assetFor("9.9.9").file;
  const sums = `${createHash("sha256").update(good).digest("hex")}  ${file}\n`;
  const srv = createServer((req, res) => {
    if (req.url.endsWith("/SHA256SUMS.txt")) return res.end(sums);
    if (req.url.endsWith(`/${file}`)) return res.end(serve);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  process.env.PQDOCTOR_DOWNLOAD_BASE = `http://127.0.0.1:${srv.address().port}`;
  const { install } = await import(`./install.mjs?base=${Date.now()}`);
  try {
    if (file.endsWith(".exe")) {
      const bin = await install("9.9.9", mkdtempSync(join(tmpdir(), "pqa-")));
      assert.deepEqual(readFileSync(bin), good);
    }
    serve = Buffer.from("tampered binary");
    await assert.rejects(install("9.9.9", mkdtempSync(join(tmpdir(), "pqa-"))), /checksum mismatch/);
    await assert.rejects(install("1.2", "x"), /version must look like/);
    await assert.rejects(install("8.8.8", mkdtempSync(join(tmpdir(), "pqa-"))), /isn't listed/);
  } finally {
    srv.close();
  }
});
