// Installs pqdoctor for the runner from npm: the `pqdoctor` launcher and the one platform package
// with the prebuilt binary for the runner. npm checks every tarball against the registry's SHA-512
// integrity hash.
// Node 20+, no dependencies.
//   node install.mjs <version> <dest-dir>   → prints the binary's path
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The npm package with the binary for this runner. */
export function platformPackage(platform = process.platform, arch = process.arch) {
  if (platform === "win32") return "@pqdoctor/win32-x64";
  if (platform === "darwin") return "@pqdoctor/darwin-universal";
  if (platform === "linux") return arch === "arm64" ? "@pqdoctor/linux-arm64" : "@pqdoctor/linux-x64";
  throw new Error(`no prebuilt pqdoctor for ${platform}/${arch} (supported: Linux x64/arm64, macOS, Windows)`);
}

/** The npm command line that installs exactly `version` into `dest`. */
export function npmArgs(version, dest) {
  return ["install", "--prefix", dest, "--no-audit", "--no-fund", "--no-save", "--include=optional", `pqdoctor@${version}`];
}

/** The binary inside an install made by npmArgs. */
export function locate(dest, platform = process.platform, arch = process.arch) {
  const bin = join(dest, "node_modules", platformPackage(platform, arch), "bin", platform === "win32" ? "pqdoctor.exe" : "pqdoctor");
  if (!existsSync(bin)) throw new Error(`npm installed pqdoctor but not its binary (${bin})`);
  return bin;
}

export function install(version, dest) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must look like 0.4.0 (got ${version})`);
  mkdirSync(dest, { recursive: true });
  // A package.json of its own, so npm doesn't climb into the repository being checked out.
  writeFileSync(join(dest, "package.json"), '{"private":true}\n');
  const win = process.platform === "win32";
  execFileSync(win ? "npm.cmd" : "npm", npmArgs(version, dest), { stdio: ["ignore", "ignore", "inherit"], shell: win });
  const bin = locate(dest);
  if (!win) chmodSync(bin, 0o755);
  return bin;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  try {
    console.log(install(process.argv[2], process.argv[3]));
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exitCode = 1;
  }
}
