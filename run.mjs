// The pqdoctor GitHub Action: runs the CLI on each host (one at a time), writes a job summary,
// annotates failures and, if asked, comments on the pull request. Exit 1 when a host fails the
// `fail-on` rule. Node 20+ (the runners' default), no dependencies.
import { execFile } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARK = "<!-- pqdoctor-action -->";

/** Hosts from the input: newline or comma separated, comments (#) and blanks dropped. */
export function parseHosts(text) {
  return [...new Set(text.split(/[\n,]/).map((h) => h.replace(/#.*$/, "").trim()).filter(Boolean))];
}

/** A fix snippet's first line of config (comments skipped), as inline code. */
function firstLine(snippet) {
  const l = (snippet ?? "").split("\n").map((x) => x.trim()).find((x) => x && !x.startsWith("#") && !x.startsWith("//"));
  return l ? `\`${l}\`` : "";
}

/** One host's outcome from pqdoctor's exit code and JSON (0 PQ, 1 not PQ, 2 unreachable). */
export function outcome(host, code, stdout, stderr) {
  let r = null;
  try {
    r = JSON.parse(stdout);
  } catch {
    r = null;
  }
  const state = code === 0 ? "pq" : code === 1 ? "not-pq" : "unreachable";
  return {
    host,
    state,
    verdict: r?.verdict ?? null,
    group: r?.group ?? r?.negotiated ?? null,
    headline: r?.headline ?? (stderr.trim() || `pqdoctor exited ${code}`),
    cause: r?.causeCode ?? null,
    fix: r?.fixes?.[0] ? [r.fixes[0].title, firstLine(r.fixes[0].snippet)].filter(Boolean).join(": ") : null,
    report: r,
  };
}

export function fails(o, failOn) {
  if (failOn === "never" || failOn === "regression") return false;
  if (o.state === "not-pq") return true;
  return failOn === "not-pq-or-unreachable" && o.state === "unreachable";
}

/** TLS hosts go through `pqdoctor scan` (SARIF, JSONL, the fingerprint); ssh:// ones one by one. */
export function splitHosts(hosts) {
  return { tls: hosts.filter((h) => !h.startsWith("ssh://")), ssh: hosts.filter((h) => h.startsWith("ssh://")) };
}

const CLASS = { config: "a config change (the library has ML-KEM)", library: "the TLS library can't do ML-KEM", provider: "a provider terminates TLS", unknown: "can't tell from outside" };

/** A scan record (pqdoctor scan --out) as an outcome row for the summary. */
export function fromRecord(r) {
  const pq = r.verdict === "pq" || r.verdict === "pqWithWarning";
  const answered = !["unreachable", "error", "skipped"].includes(r.verdict);
  const cls = r.subcause?.replace(/^no-mlkem-/, "");
  const what = r.library ?? r.provider;
  return {
    host: r.port && r.port !== 443 ? `${r.host}:${r.port}` : r.host,
    state: pq ? "pq" : answered ? "not-pq" : "unreachable",
    verdict: r.verdict,
    group: r.group ?? null,
    headline: r.headline,
    cause: r.cause ?? null,
    fix:
      r.verdict === "mixed"
        ? "post-quantum on some connections, not others: the servers behind it disagree (often a provider mid-rollout); not a regression"
        : !pq && answered
          ? `${[cls ? CLASS[cls] ?? cls : null, what ? `(${what})` : null].filter(Boolean).join(" ") || r.cause} — run \`pqdoctor ${r.host}${r.port && r.port !== 443 ? `:${r.port}` : ""}\` for the fix`
          : null,
    report: r,
  };
}

export const parseJsonl = (text) =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

/** Hosts that were post-quantum in the baseline and aren't now (pqdoctor diff --json). */
export function regressionsFrom(diffJson) {
  try {
    return (JSON.parse(diffJson).regressed ?? []).map((c) => c.target);
  } catch {
    return [];
  }
}

const ICON = { pq: "✅", "not-pq": "❌", unreachable: "⚠️" };
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function summary(results, failOn) {
  const pq = results.filter((r) => r.state === "pq").length;
  const lines = [
    MARK,
    `### pqdoctor: ${pq} of ${results.length} host${results.length === 1 ? "" : "s"} post-quantum`,
    "",
    "| | Host | Key exchange | Result | Cause |",
    "|---|---|---|---|---|",
    ...results.map((r) => `| ${ICON[r.state]} | \`${cell(r.host)}\` | ${cell(r.group ?? "—")} | ${cell(r.headline)} | ${cell(r.cause ?? "")} |`),
  ];
  const fixes = results.filter((r) => r.state === "not-pq" && r.fix);
  if (fixes.length) lines.push("", "**Fixes**", "", ...fixes.map((r) => `- \`${cell(r.host)}\`: ${cell(r.fix)}`));
  lines.push("", `<sub>fail-on: ${failOn} · handshake-only probes: only each server's first reply is read, no data is sent.</sub>`);
  return lines.join("\n");
}

function run(bin, host) {
  const ssh = host.startsWith("ssh://");
  const args = ssh ? ["ssh", host, "--json"] : [host, "--json", "--no-http"];
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 120_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 2 : 0;
      resolve(outcome(host, code, stdout, stderr));
    });
  });
}

async function comment(body) {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const pr = event.pull_request?.number;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!pr || !repo || !token) return console.log("Not a pull request (or no token): no comment.");
  const api = (path, init = {}) => fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repo}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", ...(init.headers ?? {}) } });
  const list = await (await api(`/issues/${pr}/comments?per_page=100`)).json();
  const mine = Array.isArray(list) ? list.find((c) => typeof c.body === "string" && c.body.startsWith(MARK)) : null;
  const res = mine ? await api(`/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body }) }) : await api(`/issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  if (!res.ok) console.log(`::warning::Couldn't comment on the pull request (${res.status}). Does the job have pull-requests: write?`);
}

const exec = (bin, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: 1_800_000, maxBuffer: 64 << 20, ...opts }, (err, stdout, stderr) => resolve({ code: err && typeof err.code === "number" ? err.code : err ? 2 : 0, stdout, stderr }));
  });

async function main() {
  const bin = process.env.PQDOCTOR ?? "pqdoctor";
  const tmp = process.env.RUNNER_TEMP ?? ".";
  let text = process.env.INPUT_HOSTS ?? "";
  if (process.env.INPUT_HOSTS_FILE) text += "\n" + readFileSync(process.env.INPUT_HOSTS_FILE, "utf8");
  const hosts = parseHosts(text);
  const failOn = process.env.INPUT_FAIL_ON || "not-pq";
  if (!["not-pq", "not-pq-or-unreachable", "regression", "never"].includes(failOn)) throw new Error(`fail-on must be not-pq, not-pq-or-unreachable, regression or never (got ${failOn})`);
  if (!hosts.length) throw new Error("No hosts given (input `hosts` or `hosts-file`).");
  const { tls, ssh } = splitHosts(hosts);
  const results = [];
  const resultsPath = join(tmp, "pqdoctor-results.jsonl");
  const sarifPath = join(tmp, "pqdoctor.sarif");

  // TLS: one scan — gently (2 at a time, ≤2 new/s), with the fingerprint, SARIF on stdout, records to JSONL.
  if (tls.length) {
    const list = join(tmp, "pqdoctor-hosts.txt");
    writeFileSync(list, tls.join("\n") + "\n");
    writeFileSync(resultsPath, "");
    const help = (await exec(bin, ["--help"])).stdout;
    const args = ["scan", list, "--format", "sarif", "--out", resultsPath, "-c", "2", "--rate", "2", "--quiet", ...(help.includes("--fingerprint") && process.env.INPUT_FINGERPRINT !== "false" ? ["--fingerprint"] : []), ...(help.includes("--auth") && process.env.INPUT_CERTIFICATES !== "false" ? ["--auth"] : [])];
    const s = await exec(bin, args);
    if (s.code > 1 && !s.stdout) throw new Error(`pqdoctor scan failed: ${s.stderr.trim()}`);
    writeFileSync(sarifPath, s.stdout);
    for (const r of parseJsonl(readFileSync(resultsPath, "utf8"))) results.push(fromRecord(r));
  }
  // SSH: one at a time (parallel probes trip servers' rate limiters).
  for (const h of ssh) results.push(await run(bin, h));

  for (const r of results) {
    console.log(`${ICON[r.state]} ${r.host}: ${r.headline}`);
    if (fails(r, failOn)) console.log(`::error title=Not post-quantum: ${r.host}::${r.headline}${r.fix ? ` — ${r.fix}` : ""}`);
    else if (r.state === "unreachable") console.log(`::warning title=Unreachable: ${r.host}::${r.headline}`);
  }

  // Regressions against the last run (restored from the Actions cache as INPUT_BASELINE).
  let regressed = [];
  const baseline = process.env.INPUT_BASELINE;
  if (baseline && tls.length && existsSync(baseline) && readFileSync(baseline, "utf8").trim()) {
    regressed = regressionsFrom((await exec(bin, ["diff", baseline, resultsPath, "--json"])).stdout);
    for (const h of regressed) console.log(`::error title=Regressed: ${h}::${h} was post-quantum in the last run and isn't now.`);
  }
  if (baseline && tls.length) copyFileSync(resultsPath, baseline);

  // Optional: push the run (and its plan) to a pqdoctor fleet.
  if (process.env.INPUT_FLEET_URL && process.env.FLEET_TOKEN && tls.length) {
    const args = ["push", resultsPath, "--to", process.env.INPUT_FLEET_URL, "--token", process.env.FLEET_TOKEN, "--source", `action:${process.env.GITHUB_REPOSITORY ?? "local"}`, "--with-plan", ...(process.env.INPUT_OWNERS ? ["--owners", process.env.INPUT_OWNERS] : [])];
    const p = await exec(bin, args);
    console.log(p.code === 0 ? p.stdout.trim() : `::warning::Couldn't push to the fleet: ${p.stderr.trim()}`);
  }

  let body = summary(results, failOn);
  if (regressed.length) body += `\n\n**Regressed since the last run:** ${regressed.map((h) => `\`${cell(h)}\``).join(", ")}`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + "\n");
  const reportPath = join(tmp, "pqdoctor-report.json");
  writeFileSync(reportPath, JSON.stringify(results.map((r) => ({ host: r.host, state: r.state, report: r.report })), null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pq=${results.filter((r) => r.state === "pq").length}\ntotal=${results.length}\nreport=${reportPath}\nresults=${resultsPath}\nsarif=${tls.length ? sarifPath : ""}\nregressions=${regressed.length}\n`);
  if (process.env.INPUT_COMMENT === "true") await comment(body);
  const failed = results.filter((r) => fails(r, failOn));
  if (failed.length || (failOn === "regression" && regressed.length)) {
    console.log(`${failed.length + regressed.length} failed: ${[...failed.map((r) => r.host), ...regressed].join(", ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exitCode = 1;
  });
}
