// node --test install.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, locate, npmArgs, platformPackage } from "./install.mjs";

test("the right npm package per runner", () => {
  assert.equal(platformPackage("linux", "x64"), "@pqdoctor/linux-x64");
  assert.equal(platformPackage("linux", "arm64"), "@pqdoctor/linux-arm64");
  assert.equal(platformPackage("darwin", "arm64"), "@pqdoctor/darwin-universal");
  assert.equal(platformPackage("darwin", "x64"), "@pqdoctor/darwin-universal");
  assert.equal(platformPackage("win32", "x64"), "@pqdoctor/win32-x64");
  assert.throws(() => platformPackage("aix", "ppc64"), /supported:/);
});

test("installs exactly the version asked for, with the optional binary", () => {
  const a = npmArgs("0.4.0", "/tmp/x");
  assert.ok(a.includes("pqdoctor@0.4.0"));
  assert.ok(a.includes("--include=optional"));
  assert.deepEqual(a.slice(0, 3), ["install", "--prefix", "/tmp/x"]);
});

test("finds the binary the platform package holds", () => {
  const dest = mkdtempSync(join(tmpdir(), "pqa-"));
  assert.throws(() => locate(dest, "linux", "x64"), /not its binary/);
  mkdirSync(join(dest, "node_modules", "@pqdoctor/linux-x64", "bin"), { recursive: true });
  writeFileSync(join(dest, "node_modules", "@pqdoctor/linux-x64", "bin", "pqdoctor"), "");
  assert.equal(locate(dest, "linux", "x64"), join(dest, "node_modules", "@pqdoctor/linux-x64", "bin", "pqdoctor"));
});

test("refuses a version that isn't x.y.z (no ranges, tags or URLs)", () => {
  for (const v of ["latest", "^0.4.0", "0.4", "file:../x", "0.4.0 --registry=http://evil"]) {
    assert.throws(() => install(v, mkdtempSync(join(tmpdir(), "pqa-"))), /must look like/);
  }
});
