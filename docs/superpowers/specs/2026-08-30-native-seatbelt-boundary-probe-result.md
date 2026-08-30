# Native Seatbelt boundary probe result

## Current terminal status

**NO-GO**

Authorized run #7 completed the full N1 harness after the socket-path correction in `925bddb`.
All ten containment cases passed, cleanup was confirmed, and latency thresholds passed. Terminal
status remains **NO-GO** because the runtime closure skipped four otool-reported dependencies and
the compiled profile records five inventory-tracked broad grants that the decision gate requires
to be absent for GO.

- Invocation: `pnpm probe:native-seatbelt-boundary`
- Probe commit: `2254a92` (`docs: record blocked N1 probe run six`)
- Host: macOS product version 26.5.1; Darwin kernel 25.5.0; architecture arm64
- Substrate role `<SANDBOX_EXEC>` SHA-256: `8857d087219f0f39d3e3c163e5d0a0aed690cc22f34b50c7eee3d74f93e69688`
- Runtime executable role `<RUNTIME_FILE>` SHA-256: `7bf25453c4280d0c4b8501144e419dd9597eeddd5804c4f4ab571d3286489547`
- Runtime skipped dependency count: **4** (otool-reported framework and `/usr/lib` paths absent as regular files on this host; reason codes recorded in private manifest)
- Private evidence directory role: `<PRIVATE_EVIDENCE_DIR>` (raw path recorded only in the private manifest; not committed)
- Evidence manifest SHA-256: `0abb0ef66f092d97c76c23b32aff243d54602a3fb1d09c9c34082e557dde09ff` (SHA-256 over sorted raw evidence **file name + bytes + file hash** entries; not a synthetic report object)
- Profile source SHA-256: `758a1d35f4ef64334f6c89ae82030994374a6b3ccdbde02b711a62eb4c7b8d1f`
- Sandboxed child started: **yes**
- Required cases completed: **10/10**
- Latency pairs completed: **30/30**
- Docker was neither inspected nor invoked.

## Profile grant inventory (roles)

| Category | Role / import | Operation | Notes |
| --- | --- | --- | --- |
| Baseline | `dyld-support.sb` | import | Apple dyld bootstrap profile |
| Process | baseline | `process-fork`, `signal (target self)`, `mach-lookup`, `sysctl-read` | Minimum process control |
| Metadata | baseline | `file-read-metadata` | Directory traversal for canonical `/private/var/...` temp paths |
| Mirror fixture | `<MIRROR_ROOT>` | `file-read*`, `file-write*` | subpath |
| Evidence output | `<PRIVATE_EVIDENCE_DIR>` | `file-read*`, `file-write*` | subpath |
| Runtime | `<RUNTIME_FILE>` | `process-exec`, `file-read*` | literal |
| System literal | `<DEV_NULL>` | `file-read-data` | `/dev/null` |
| System literal | `<DYLD>` | `file-read-data` | `/usr/lib/dyld` |
| System subpath | `system-openssl` | `file-read*` | `/System/Library/OpenSSL` |
| Inventory-tracked broad grants | `baseline-import:dyld-support.sb` | import | Recorded by harness; gate requires zero |
| Inventory-tracked broad grants | `global-mach-lookup` | mach-lookup | Recorded by harness; gate requires zero |
| Inventory-tracked broad grants | `global-sysctl-read` | sysctl-read | Recorded by harness; gate requires zero |
| Inventory-tracked broad grants | `global-file-read-metadata` | file-read-metadata | Recorded by harness; gate requires zero |
| Inventory-tracked broad grants | `system-openssl` | file-read* | Recorded by harness; gate requires zero |

## Required containment cases

| Case | Pass | Exit | Signal | Timed out | Marker / listener / hash evidence |
| --- | --- | --- | --- | --- | --- |
| mirror-read-write | yes | 0 | — | no | Mirror read/write succeeded; pre/post sentinel hash unchanged |
| source-read-write | yes | 1 | — | no | Read **and** write denied; pre/post hash unchanged |
| home-secret-read-write | yes | 1 | — | no | Read **and** write denied; fake-home hash unchanged |
| control-plane-read-write | yes | 1 | — | no | Read **and** write denied; control-plane hash unchanged |
| absolute-path-read-write | yes | 1 | — | no | Read **and** write denied; absolute target hash unchanged |
| loopback-tcp | yes | 1 | — | no | Connect denied; parent TCP listener accepted 0 connections |
| unix-socket | yes | 1 | — | no | Connect denied; parent Unix listener accepted 0 connections |
| descendant-inheritance | yes | 0 | — | no | Four forbidden descendant operations each denied independently |
| timeout-process-group | yes | — | SIGTERM | yes | Timed out; post-cleanup marker **absent** |
| output-capture | yes | 37 | — | no | stdout/stderr markers captured; exit 37 observed |

Cleanup confirmed: **yes**

## Paired latency overhead (30 samples after 5 warm-up pairs)

Thresholds: median ≤ 100 ms, p95 ≤ 250 ms.

Summary: median overhead **13.34 ms**; p95 overhead **32.16 ms**. Latency thresholds **pass**.

Overhead samples (ms):

`17.62, 39.23, 32.16, 20.97, 9.65, 1.76, 22.18, 17.50, 25.30, 0.00, 13.34, 10.83, 17.13, 27.71, 3.77, 15.59, 9.59, 20.16, 13.86, 14.51, 11.18, 0.00, 7.04, 6.45, 5.40, 13.49, 11.22, 1.88, 0.61, 16.17`

(Full paired baseline/sandboxed durations remain in private `<PRIVATE_EVIDENCE_DIR>/latency.ndjson`.)

## Authorized-run history

Earlier results are retained as harness history. They are not substituted for the latest reviewed
run and do not authorize N2.

| Attempt | Manifest | Recorded outcome | Review status / root cause |
| --- | --- | --- | --- |
| Pre-auth #1–2 | none | harness failure | Missing profile flag and path canonicalization defects |
| Authorized #1 | `5d313611…` | NO-GO | Evidence directory was granted as a literal instead of a subpath |
| Authorized #2–4 | various | NO-GO / GO | Invalid harness evidence; #4 placed the cleanup marker outside the sandbox write grant |
| Authorized #5 | `415bbf6b…` | NO-GO | Invalid terminal rationale: a marker written before timeout was mistaken for post-cleanup survival; skipped runtime dependencies and implicit broad grants were not gated |
| Authorized #6 | none | BLOCKED | Unix socket path exceeded the macOS limit before the first sandboxed child |
| **Authorized #7** | **`0abb0ef6…`** | **NO-GO** | **Full harness pass on containment and latency; four skipped runtime dependencies and five inventory-tracked broad grants fail the GO gate** |

## Correction applied before #7

Commit `925bddb` (`fix: shorten native probe socket path`) makes macOS fixture creation use the
short `/tmp/belay-native-seatbelt-probe-` prefix while retaining a mode-0700 private tree. Run #7
validated that correction on a live host without replacing the #6 BLOCKED record above.

## Review boundary

This document is redacted. Raw NDJSON transcripts, stderr stacks, sentinel values, usernames,
absolute temp paths, environment secrets, and the full private evidence tree remain outside Git.
Reviewers may reconcile case counts, latency samples, grant inventory roles, raw file manifest
hash, and terminal status against the private manifest at `<PRIVATE_EVIDENCE_DIR>`.

Run #6 created a private temporary fixture but no raw evidence manifest; none of its absolute
paths, generated sentinels, or copied fixture files are committed or presented as #6 evidence
beyond the startup failure record in the history table.

## Decision

Terminal status: **NO-GO**

Rule applied: N1 requires every required allow/deny case to pass, cleanup to be confirmed, zero
skipped runtime dependencies, zero inventory-tracked broad grants, and latency within budget.
Run #7 passes containment (10/10), cleanup, and latency (median 13.34 ms, p95 32.16 ms). It fails
GO because **four** otool-reported runtime dependencies were skipped during closure construction
and the compiled profile records **five** inventory-tracked broad grants (`dyld-support.sb` import,
global `mach-lookup`, global `sysctl-read`, global `file-read-metadata`, and
`/System/Library/OpenSSL` subpath read).

Native unknown execution via Seatbelt on this recorded host is not authorized. Ordinary exact
approval remains in place. No production driver, ADR-007, or Workstream C plan is created by this
result. N2 must not proceed.
