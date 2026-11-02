# pqdoctor GitHub Action

Post-quantum TLS checks in CI: which of your hosts negotiate hybrid ML-KEM (X25519MLKEM768), **why the rest don't** — a config change, a TLS library that can't, or a provider's product — with the fix; SARIF for code scanning; regressions since the last run; and an optional push to a [pqdoctor fleet](https://pqdoctor.com/pqdoctor/guides/enterprise/) dashboard.

```yaml
name: post-quantum
on:
  schedule: [{ cron: "17 6 * * *" }]   # every morning
  pull_request:
permissions:
  contents: read
  security-events: write   # upload-sarif
  pull-requests: write     # comment
jobs:
  pq:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Kalyan-Deva/pqdoctor-action@v1
        with:
          hosts-file: pq/hosts.txt          # e.g. from `pqdoctor inventory ct:example.com zone:…`
          hosts: ssh://github.com
          fail-on: regression                # fail only when something that was PQ stops being PQ
          upload-sarif: true
          comment: true
          fleet-url: https://fleet.example.com
          fleet-token: ${{ secrets.PQDOCTOR_FLEET_TOKEN }}
          owners: pq/owners.toml
```

| Input | Default | |
|---|---|---|
| `hosts` | | one per line or comma-separated; `host`, `host:port`, `ssh://host` |
| `hosts-file` | | more hosts from a file (`#` comments) |
| `fail-on` | `not-pq` | `not-pq`, `not-pq-or-unreachable`, `regression`, `never` |
| `fingerprint` | `true` | config / library / provider for non-PQ hosts |
| `certificates` | `true` | each TLS host's chain: does it serve ML-DSA, and would the chain still fit the first flight with it |
| `version` | `0.4.0` | the pqdoctor release to install |
| `install` | `release` | `release`: the prebuilt binary, **verified against the release's `SHA256SUMS.txt`** before it runs; `source`: build that version from crates.io with cargo (Rust 1.85+) |
| `upload-sarif` | `false` | upload to code scanning (`security-events: write`) |
| `comment` | `false` | one PR comment, updated on re-runs (`pull-requests: write`) |
| `fleet-url`, `fleet-token`, `owners` | | push the run, its leverage plan and teams to a fleet |

Outputs: `pq`, `total`, `regressions`, `report` (JSON), `results` (JSONL, for `pqdoctor diff / plan / tickets / push`), `sarif`.

The last run's records are kept in the Actions cache, so `fail-on: regression` compares like for like. TLS hosts are scanned gently (2 at a time, at most 2 new connections a second, handshake-only); SSH hosts one at a time.

## How the binaries are built

`install: release` downloads from this repository's `pqdoctor-v<version>` release, and from `https://pqdoctor.com/downloads/v<version>/` if that fails (same files). The Linux (static musl, x64 + arm64) and macOS (universal) archives are built by this repository's `build` workflow from the published crate (`cargo install pqdoctor --version <v> --locked`), so anyone can check them against the crates.io source; the Windows exe is built the same way. Every file is listed in that release's `SHA256SUMS.txt`, and the action refuses a binary whose hash doesn't match.

Tests: `node --test run.test.mjs install.test.mjs`; the `test` workflow runs the action itself against live hosts.
