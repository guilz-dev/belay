# Native Seatbelt boundary probe result

- Invocation: `pnpm probe:native-seatbelt-boundary` (`node scripts/native-seatbelt-boundary-probe.mjs --live`).
- Host: macOS product version 26.5.1 (build 25F80); Darwin kernel 25.5.0; architecture arm64.
- Substrate role `<SANDBOX_EXEC>` SHA-256: `8857d087219f0f39d3e3c163e5d0a0aed690cc22f34b50c7eee3d74f93e69688`.
- Runtime executable role `<RUNTIME_FILE>` SHA-256: `7bf25453c4280d0c4b8501144e419dd9597eeddd5804c4f4ab571d3286489547` (closure contained only the Node executable; otool-reported framework and `/usr/lib` library paths were absent as regular files on this host).
- Private evidence directory role: `<PRIVATE_EVIDENCE_DIR>` (raw path recorded only in the private manifest; not committed).
- Evidence manifest SHA-256: `3720451f48956a874fde957a94ce2310fd27cb1bc7e9f72d34ed9add587215bd`.
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
| Forbidden broad grants | — | — | none recorded |

## Required containment cases

| Case | Pass | Exit | Signal | Timed out | Marker / listener / hash evidence |
| --- | --- | --- | --- | --- | --- |
| mirror-read-write | yes | 0 | — | no | Mirror read/write succeeded; sentinel absent from captured output |
| source-read-write | yes | 1 | — | no | Read/write denied; forbidden-source sentinel hash unchanged |
| home-secret-read-write | yes | 1 | — | no | Read/write denied; fake-home secret hash unchanged |
| control-plane-read-write | yes | 1 | — | no | Read/write denied; control-plane sentinel hash unchanged |
| absolute-path-read-write | yes | 1 | — | no | Read/write denied; absolute-forbidden sentinel hash unchanged |
| loopback-tcp | yes | 1 | — | no | Connect denied; parent TCP listener accepted 0 connections |
| unix-socket | yes | 1 | — | no | Connect denied; parent Unix listener accepted 0 connections |
| descendant-inheritance | yes | 0 | — | no | Four forbidden descendant operations each denied independently |
| timeout-process-group | yes | — | SIGTERM | yes | Process group timed out; post-cleanup descendant marker absent |
| output-capture | yes | 37 | — | no | stdout/stderr markers captured; exit 37 observed |

Cleanup confirmed: **yes**.

## Paired latency overhead (30 samples after 5 warm-up pairs)

Thresholds: median ≤ 100 ms, p95 ≤ 250 ms.

| Pair | Baseline ms | Sandboxed ms | Overhead ms | Baseline first |
| --- | ---: | ---: | ---: | --- |
| 0 | 37.333 | 66.312 | 28.979 | yes |
| 1 | 42.729 | 66.407 | 23.678 | no |
| 2 | 35.498 | 61.303 | 25.804 | yes |
| 3 | 69.562 | 70.182 | 0.619 | no |
| 4 | 43.578 | 59.555 | 15.977 | yes |
| 5 | 39.716 | 59.991 | 20.276 | no |
| 6 | 39.134 | 49.202 | 10.068 | yes |
| 7 | 76.951 | 214.473 | 137.522 | no |
| 8 | 35.667 | 91.622 | 55.955 | yes |
| 9 | 32.555 | 68.932 | 36.377 | no |
| 10 | 29.892 | 36.028 | 6.137 | yes |
| 11 | 31.526 | 40.539 | 9.013 | no |
| 12 | 35.296 | 44.964 | 9.668 | yes |
| 13 | 49.526 | 47.926 | 0.000 | no |
| 14 | 41.486 | 72.165 | 30.679 | yes |
| 15 | 51.358 | 67.780 | 16.423 | no |
| 16 | 47.202 | 55.808 | 8.606 | yes |
| 17 | 70.073 | 66.257 | 0.000 | no |
| 18 | 67.283 | 53.877 | 0.000 | yes |
| 19 | 39.143 | 39.222 | 0.079 | no |
| 20 | 35.509 | 56.256 | 20.747 | yes |
| 21 | 41.947 | 59.525 | 17.578 | no |
| 22 | 40.115 | 59.213 | 19.098 | yes |
| 23 | 36.557 | 58.570 | 22.013 | no |
| 24 | 39.587 | 38.728 | 0.000 | yes |
| 25 | 33.850 | 64.240 | 30.390 | no |
| 26 | 44.100 | 72.859 | 28.758 | yes |
| 27 | 91.886 | 54.179 | 0.000 | no |
| 28 | 179.577 | 114.103 | 0.000 | yes |
| 29 | 55.029 | 69.312 | 14.282 | no |

Summary: median overhead **15.977 ms**; p95 overhead **55.955 ms**. Latency thresholds **pass**.

## Earlier harness failures (not counted as evidence)

These runs were recorded separately while fixing probe harness defects. They are **not** merged into the authorized run above.

| Attempt | Manifest | Outcome | Root cause |
| --- | --- | --- | --- |
| Pre-auth #1–2 | none | harness failure | Missing `-f` profile flag; path canonicalization defects |
| Authorized #1 | `5d313611…` | NO-GO | Evidence dir granted as Seatbelt `literal` instead of `subpath`; child NDJSON append EPERM |
| Authorized #2 | `ac4c7219…` | NO-GO | Descendant evidence shape mismatch; timeout grandchild spawn EPERM (`-e` / internal case gate) |
| Authorized #3 | `c6ecc7b4…` | NO-GO | Timeout grandchild still failing before internal-case fix |
| **Authorized #4** | **`3720451f…`** | **GO** | **Final harness after evidence subpath, descendant NDJSON, and timeout-grandchild fixes** |

## Review boundaries

This document is redacted. Raw NDJSON transcripts, stderr stacks, sentinel values, usernames, absolute temp paths, environment secrets, and the full private evidence tree remain outside Git. Reviewers may reconcile case counts, latency samples, grant inventory roles, manifest hash, and terminal status against the private manifest at `<PRIVATE_EVIDENCE_DIR>`.

## Decision

Terminal status: **GO**

Rule applied: every required allow/deny case passed, descendants inherited the boundary, cleanup was confirmed, no forbidden broad grant was present, and latency median (15.977 ms) and p95 (55.955 ms) were within budget.

N1 authorizes creation of a separate N2 Cursor deny-to-MCP continuation design review and probe plan on this host profile. ADR-007, production drivers, and Workstream C implementation remain absent until N2 is also GO.
