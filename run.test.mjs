// node --test action/pqdoctor/run.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { fails, fromRecord, outcome, parseHosts, parseJsonl, regressionsFrom, splitHosts, summary } from "./run.mjs";

test("hosts: newlines, commas, comments, duplicates", () => {
  assert.deepEqual(parseHosts("example.com\n  api.example.com:8443, ssh://git.example.com\n# staging\nexample.com\n\n"), ["example.com", "api.example.com:8443", "ssh://git.example.com"]);
});

test("exit codes and JSON become outcomes", () => {
  const pq = outcome("a.example", 0, JSON.stringify({ verdict: "pq", group: "X25519MLKEM768", headline: "Post-quantum: negotiates X25519MLKEM768", causeCode: "pq-preferred", fixes: [] }), "");
  assert.equal(pq.state, "pq");
  const no = outcome("b.example", 1, JSON.stringify({ verdict: "notPq", group: "X25519", headline: "Not post-quantum", causeCode: "no-mlkem", fixes: [{ title: "Upgrade to OpenSSL 3.5", detail: "…", snippet: "# nginx\nssl_ecdh_curve X25519MLKEM768:X25519;\n# reload" }] }), "");
  assert.deepEqual([no.state, no.cause, no.fix], ["not-pq", "no-mlkem", "Upgrade to OpenSSL 3.5: `ssl_ecdh_curve X25519MLKEM768:X25519;`"]);
  const down = outcome("c.example", 2, "", "pqdoctor: couldn't resolve c.example\n");
  assert.deepEqual([down.state, down.headline], ["unreachable", "pqdoctor: couldn't resolve c.example"]);
  assert.equal(outcome("d.example", 64, "", "").state, "unreachable");
});

test("fail-on rules", () => {
  const s = (state) => ({ state });
  assert.deepEqual(["pq", "not-pq", "unreachable"].map((x) => fails(s(x), "not-pq")), [false, true, false]);
  assert.deepEqual(["pq", "not-pq", "unreachable"].map((x) => fails(s(x), "not-pq-or-unreachable")), [false, true, true]);
  assert.deepEqual(["pq", "not-pq", "unreachable"].map((x) => fails(s(x), "never")), [false, false, false]);
});

test("scan records become summary rows with the class and library", () => {
  const rows = parseJsonl('{"host":"a.example","port":443,"verdict":"pq","cause":"pq-preferred","group":"X25519MLKEM768","headline":"Post-quantum"}\nnot json\n{"host":"b.example","port":8443,"verdict":"notPq","cause":"no-mlkem","subcause":"no-mlkem-library","library":"OpenSSL 1.1.1","headline":"Not post-quantum"}\n{"host":"c.example","port":443,"verdict":"unreachable","cause":"no-reply","headline":"No reply"}\n').map(fromRecord);
  assert.deepEqual(rows.map((r) => [r.host, r.state]), [["a.example", "pq"], ["b.example:8443", "not-pq"], ["c.example", "unreachable"]]);
  assert.equal(rows[1].fix, "the TLS library can't do ML-KEM (OpenSSL 1.1.1) — run `pqdoctor b.example:8443` for the fix");
  assert.equal(rows[0].fix, null);
});

test("hosts split into TLS and SSH; regression fail-on only fails on regressions", () => {
  assert.deepEqual(splitHosts(["a.example", "ssh://git.example", "b.example:8443"]), { tls: ["a.example", "b.example:8443"], ssh: ["ssh://git.example"] });
  assert.equal(fails({ state: "not-pq" }, "regression"), false);
  assert.deepEqual(regressionsFrom(JSON.stringify({ regressed: [{ target: "x.example:443" }], fixed: [] })), ["x.example:443"]);
  assert.deepEqual(regressionsFrom("not json"), []);
});

test("summary: a table, the fixes, and the marker for updating one comment", () => {
  const md = summary([outcome("a|b.example", 0, JSON.stringify({ group: "X25519MLKEM768", headline: "ok" }), ""), outcome("b.example", 1, JSON.stringify({ headline: "no", causeCode: "no-mlkem", fixes: [{ title: "Fix it" }] }), "")], "not-pq");
  assert.ok(md.startsWith("<!-- pqdoctor-action -->"));
  assert.match(md, /pqdoctor: 1 of 2 hosts post-quantum/);
  assert.match(md, /\| ✅ \| `a\\\|b\.example` \| X25519MLKEM768 \|/);
  assert.match(md, /- `b\.example`: Fix it/);
});

test("a mixed host (post-quantum on some connections) isn't post-quantum, and says why", () => {
  const [m] = parseJsonl('{"host":"g.example","port":443,"verdict":"mixed","cause":"no-mlkem","headline":"Mixed: post-quantum on some connections, not on others"}\n').map(fromRecord);
  assert.equal(m.state, "not-pq");
  assert.match(m.fix, /not a regression/);
  assert.equal(fails(m, "regression"), false);
  assert.equal(regressionsFrom(JSON.stringify({ regressed: [], mixed: [{ target: "g.example:443" }] })).length, 0);
});
