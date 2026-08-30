# Native Seatbelt boundary probe result

- Invocation: `pnpm probe:native-seatbelt-boundary` (`node scripts/native-seatbelt-boundary-probe.mjs --live`).
- Host: macOS product version 26.5.1 (build 25F80); Darwin kernel 25.5.0; architecture arm64.
- Substrate role `<SANDBOX_EXEC>` SHA-256: `8857d087219f0f39d3e3c163e5d0a0aed690cc22f34b50c7eee3d74f93e69688`.
- Runtime executable role `<RUNTIME_FILE>` SHA-256: `7bf25453c4280d0c4b8501144e419dd9597eeddd5804c4f4ab571d3286489547`.
- Runtime skipped dependency count: **4** (otool-reported framework and `/usr/lib` paths absent as regular files on this host; recorded with reason codes in private manifest).
- Private evidence directory role: `<PRIVATE_EVIDENCE_DIR>` (raw path recorded only in the private manifest; not committed).
- Evidence manifest SHA-256: `415bbf6b96d4adb9853575f0d9422a686923cca467d58446e543d145f0c6f308` (SHA-256 over sorted raw evidence **file name + bytes + file hash** entries; not a synthetic report object).
- Docker was neither inspected nor invoked.

## Profile grant inventory (roles)

| Category | Role / import | Operation | Notes |
| --- | --- | --- | --- |
| Baseline | `dyld-support.sb` | import | Apple dyld bootstrap profile |
| Process | baseline | `process-fork`, `signal (target self)`, `mach-lookup`, `sysctl-read` | Minimum process control |
| Metadata | baseline | `file-read-metadata` | Directory traversal for canonical `/private/var/...` temp paths |
| Mirror fixture | `<MIRROR_ROOT>` | `file-read*`, `file-write*` | subpath |
| Evidence output | `<PRIVATE_EVIDENCE_DIR>` | `file-read*`, `file-write*` | subpath (includes post-cleanup marker path) |
| Runtime | `<RUNTIME_FILE>` | `process-exec`, `file-read*` | literal |
| System literal | `<DEV_NULL>` | `file-read-data` | `/dev/null` |
| System literal | `<DYLD>` | `file-read-data` | `/usr/lib/dyld` |
| System subpath | `system-openssl` | `file-read*` | `/System/Library/OpenSSL` |
| Forbidden broad grants | — | — | none recorded |

## Required containment cases

| Case | Pass | Exit | Signal | Timed out | Marker / listener / hash evidence |
| --- | --- | --- | --- | --- | --- |
| mirror-read-write | yes | 0 | — | no | Mirror read/write succeeded; pre/post sentinel hash unchanged |
| source-read-write | yes | 1 | — | no | Read **and** write denied; pre/post hash unchanged; no leak in streams |
| home-secret-read-write | yes | 1 | — | no | Read **and** write denied; fake-home hash unchanged; mirror manifest omits sentinel values |
| control-plane-read-write | yes | 1 | — | no | Read **and** write denied; control-plane hash unchanged |
| absolute-path-read-write | yes | 1 | — | no | Read **and** write denied; absolute target hash unchanged |
| loopback-tcp | yes | 1 | — | no | Connect denied; parent TCP listener accepted 0 connections |
| unix-socket | yes | 1 | — | no | Connect denied; parent Unix listener accepted 0 connections |
| descendant-inheritance | yes | 0 | — | no | Four forbidden descendant operations each denied independently |
| timeout-process-group | **no** | — | SIGTERM | yes | Timed out, but post-cleanup marker **present** (`survived` written by grandchild) |
| output-capture | yes | 37 | — | no | stdout/stderr markers captured; exit 37 observed |

Cleanup confirmed: **no** (timeout case failed with surviving descendant marker).

## Paired latency overhead (30 samples after 5 warm-up pairs)

Thresholds: median ≤ 100 ms, p95 ≤ 250 ms.

Summary: median overhead **7.34 ms**; p95 overhead **15.70 ms**. Latency thresholds **pass**.

(Full 30-pair table remains in private `<PRIVATE_EVIDENCE_DIR>/latency.ndjson`.)

## Earlier harness failures (not counted as evidence)

| Attempt | Manifest | Outcome | Root cause |
| --- | --- | --- | --- |
| Pre-auth #1–2 | none | harness failure | Missing `-f` profile flag; path canonicalization defects |
| Authorized #1 | `5d313611…` | NO-GO | Evidence dir granted as Seatbelt `literal` instead of `subpath` |
| Authorized #2–4 | various | NO-GO / **invalid GO** | Descendant/timeout harness defects; **GO #4 used cleanup marker outside sandbox write grant (false-positive cleanup pass)** |
| **Authorized #5** | **`415bbf6b…`** | **NO-GO** | **Hardened harness: 9/10 security cases pass; timeout cleanup fails with honest marker detection** |

## Review boundaries

This document is redacted. Raw NDJSON transcripts, stderr stacks, sentinel values, usernames, absolute temp paths, environment secrets, and the full private evidence tree remain outside Git. Reviewers may reconcile case counts, latency samples, grant inventory roles, raw file manifest hash, and terminal status against the private manifest at `<PRIVATE_EVIDENCE_DIR>`.

## Decision

Terminal status: **NO-GO**

Rule applied: N1 requires every required allow/deny case to pass **and** cleanup to be confirmed. Deny cases, descendant inheritance, mirror allow-path, and output capture pass under the hardened harness (read **and** write denial, pre-case hashes, mirror manifest without sentinel values, raw file manifest hash). **timeout-process-group** fails because the SIGTERM/SIGKILL sequence did not prevent the ignoring grandchild from writing the post-cleanup survival marker within the granted evidence subpath. Latency passes but does not override the cleanup failure.

Native unknown execution via Seatbelt on this recorded host is not authorized. Ordinary exact approval remains in place. No production driver, ADR-007, or Workstream C plan is created by this result. N2 must not proceed.
