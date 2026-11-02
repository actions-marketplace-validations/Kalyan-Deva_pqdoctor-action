// Installs a prebuilt pqdoctor release for the runner, verified against the release's
// SHA256SUMS.txt before it's used. Node 20+, no dependencies.
//   node install.mjs <version> <dest-dir>   → prints the binary's path
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Where a version's files come from, tried in order. This repository's own release first: GitHub's
// runners always reach it (pqdoctor.com has refused some runner addresses with 403), and it holds
// the same files and SHA256SUMS.txt, built and attested by the `build` workflow. Then pqdoctor.com.
// PQDOCTOR_DOWNLOAD_BASE (one or more, comma-separated, each holding v<version>/) replaces both.
export function basesFor(version) {
  if (process.env.PQDOCTOR_DOWNLOAD_BASE) return process.env.PQDOCTOR_DOWNLOAD_BASE.split(",").map((b) => `${b.trim()}/v${version}`);
  return [`https://github.com/Kalyan-Deva/pqdoctor-action/releases/download/pqdoctor-v${version}`, `https://pqdoctor.com/downloads/v${version}`];
}

/** The release file for this runner (RUNNER_OS / process.platform, arch). */
export function assetFor(version, platform = process.platform, arch = process.arch) {
  if (platform === "win32") return { file: `pqdoctor-${version}-windows-x64.exe`, archive: false, bin: "pqdoctor.exe" };
  if (platform === "darwin") return { file: `pqdoctor-${version}-macos-universal.tar.gz`, archive: true, bin: `pqdoctor-${version}-macos-universal/pqdoctor` };
  if (platform === "linux") {
    const a = arch === "arm64" ? "arm64" : "x64";
    return { file: `pqdoctor-${version}-linux-${a}.tar.gz`, archive: true, bin: `pqdoctor-${version}-linux-${a}/pqdoctor` };
  }
  throw new Error(`no pqdoctor release for ${platform}/${arch}`);
}

/** The SHA-256 for `file` from a SHA256SUMS.txt ("<hex>  <file>" lines). */
export function sumFor(sums, file) {
  for (const line of sums.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2].trim() === file) return m[1].toLowerCase();
  }
  return null;
}

async function get(url) {
  const r = await fetch(url, { headers: { "user-agent": "pqdoctor-action" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function install(version, dest) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must look like 0.3.0 (got ${version})`);
  const a = assetFor(version);
  let data;
  const failed = [];
  for (const base of basesFor(version)) {
    let sums;
    try {
      sums = new TextDecoder().decode(await get(`${base}/SHA256SUMS.txt`));
    } catch (e) {
      failed.push(e.message); // unreachable here: try the next source
      continue;
    }
    const want = sumFor(sums, a.file);
    if (!want) throw new Error(`${a.file} isn't listed in ${base}/SHA256SUMS.txt`);
    try {
      data = await get(`${base}/${a.file}`);
    } catch (e) {
      failed.push(e.message);
      continue;
    }
    const got = createHash("sha256").update(data).digest("hex");
    if (got !== want) throw new Error(`checksum mismatch for ${a.file}: expected ${want}, got ${got} — not installing it`);
    break;
  }
  if (!data) throw new Error(`couldn't download ${a.file}: ${failed.join("; ")}`);
  mkdirSync(dest, { recursive: true });
  const saved = join(dest, a.file);
  writeFileSync(saved, data);
  let bin = saved;
  if (a.archive) {
    execFileSync("tar", ["-xzf", saved, "-C", dest]);
    bin = join(dest, a.bin);
  }
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  install(process.argv[2], process.argv[3])
    .then((b) => console.log(b))
    .catch((e) => {
      console.log(`::error::${e.message}`);
      process.exitCode = 1;
    });
}
