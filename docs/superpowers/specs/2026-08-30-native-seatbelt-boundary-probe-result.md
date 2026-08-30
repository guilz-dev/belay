# Native Seatbelt boundary probe result

- Invocation: `pnpm probe:native-seatbelt-boundary` (`node scripts/native-seatbelt-boundary-probe.mjs --live`).
- Host: macOS product version 26.5.1 (build 25F80); Darwin kernel 25.5.0; architecture arm64.
- Substrate role `<SANDBOX_EXEC>` SHA-256: `8857d087219f0f39d3e3c163e5d0a0aed690cc22f34b50c7eee3d74f93e69688`.
- Runtime executable role `<RUNTIME_FILE>` SHA-256: `7bf25453c4280d0c4b8501144e419dd9597eeddd5804c4f4ab571d3286489547` (closure contained only the Node executable; otool-reported framework and `/usr/lib` dependencies were absent as regular files on this host).
- Private evidence directory role: `<PRIVATE_EVIDENCE_DIR>` (raw path recorded only in the private manifest; not committed).
- Evidence manifest SHA-256: `5d31361131d0e269106ea80d8c50ffd2879a6a21b65af60ac94cbcbb137c6a2c`.
- Docker was neither inspected nor invoked.

## Profile grant inventory (roles)

| Category | Role / import | Operation | Notes |
| --- | --- | --- | --- |
| Baseline | `dyld-support.sb` | import | Apple dyld bootstrap profile |
| Process | baseline | `process-fork`, `signal (target self)`, `mach-lookup`, `sysctl-read` | Minimum process control |
| Metadata | baseline | `file-read-metadata` | Directory traversal for canonical `/private/var/...` temp paths |
| Mirror fixture | `<MIRROR_ROOT>` | `file-read*`, `file-write*` | subpath |
| Evidence output | `<PRIVATE_EVIDENCE_DIR>` | `file-read*`, `file-write*` | literal (directory path only) |
| Runtime | `<RUNTIME_FILE>` | `process-exec`, `file-read*` | literal |
| System literal | `<DEV_NULL>` | `file-read-data` | `/dev/null` |
| System literal | `<DYLD>` | `file-read-data` | `/usr/lib/dyld` |
| System subpath | `system-openssl` | `file-read*` | `/System/Library/OpenSSL` |
| Forbidden broad grants | — | — | none recorded |

Profile source SHA-256: `1f9c72fe866b5bb24dadd95f1c262eaabfc88df1d726b150ec0dce55d923b423`.

## Required containment cases

| Case | Pass | Exit | Signal | Timed out | Marker / listener / hash evidence |
| --- | --- | --- | --- | --- | --- |
| mirror-read-write | no | 1 | — | no | Allow-path write succeeded in mirror but evidence NDJSON append EPERM; operation denied |
| source-read-write | yes | 1 | — | no | Read/write denied; forbidden-source sentinel hash unchanged; sentinel absent from captured output |
| home-secret-read-write | yes | 1 | — | no | Read/write denied; fake-home secret hash unchanged; sentinel absent |
| control-plane-read-write | yes | 1 | — | no | Read/write denied; control-plane sentinel hash unchanged; sentinel absent |
| absolute-path-read-write | yes | 1 | — | no | Read/write denied; absolute-forbidden sentinel hash unchanged; sentinel absent |
| loopback-tcp | yes | 1 | — | no | Connect denied; parent TCP listener accepted 0 connections |
| unix-socket | yes | 1 | — | no | Connect denied; parent Unix listener accepted 0 connections |
| descendant-inheritance | no | 1 | — | no | Child completed but evidence NDJSON append EPERM; forbidden descendant operations not fully evidenced |
| timeout-process-group | no | 1 | — | no | Grandchild spawn EPERM; probe did not reach timeout settlement; cleanup unconfirmed |
| output-capture | no | 1 | — | no | stdout/stderr markers captured by parent streams; exit 37 not observed because evidence append EPERM |

Cleanup confirmed: **no** (timeout case did not pass; post-cleanup marker check not reached).

## Paired latency overhead (30 samples after 5 warm-up pairs)

Thresholds: median ≤ 100 ms, p95 ≤ 250 ms.

| Pair | Baseline ms | Sandboxed ms | Overhead ms | Baseline first |
| --- | ---: | ---: | ---: | --- |
| 0 | 68.286 | 79.563 | 11.277 | yes |
| 1 | 64.228 | 84.506 | 20.278 | no |
| 2 | 60.261 | 121.932 | 61.672 | yes |
| 3 | 69.439 | 77.922 | 8.483 | no |
| 4 | 49.105 | 73.713 | 24.607 | yes |
| 5 | 59.343 | 75.039 | 15.696 | no |
| 6 | 84.064 | 77.294 | 0 | yes |
| 7 | 52.470 | 65.894 | 13.424 | no |
| 8 | 71.036 | 117.025 | 45.989 | yes |
| 9 | 138.848 | 127.517 | 0 | no |
| 10 | 41.900 | 69.450 | 27.550 | yes |
| 11 | 65.873 | 64.823 | 0 | no |
| 12 | 54.377 | 88.472 | 34.095 | yes |
| 13 | 63.367 | 90.133 | 26.766 | no |
| 14 | 80.028 | 90.746 | 10.718 | yes |
| 15 | 129.580 | 77.672 | 0 | no |
| 16 | 242.710 | 311.286 | 68.576 | yes |
| 17 | 83.448 | 146.066 | 62.618 | no |
| 18 | 89.824 | 100.025 | 10.201 | yes |
| 19 | 57.280 | 60.749 | 3.468 | no |
| 20 | 100.562 | 61.151 | 0 | yes |
| 21 | 36.641 | 50.290 | 13.648 | no |
| 22 | 55.551 | 75.828 | 20.277 | yes |
| 23 | 47.861 | 182.832 | 134.970 | no |
| 24 | 71.170 | 60.050 | 0 | yes |
| 25 | 40.315 | 59.846 | 19.531 | no |
| 26 | 37.941 | 54.691 | 16.750 | yes |
| 27 | 37.076 | 79.743 | 42.668 | no |
| 28 | 41.491 | 80.354 | 38.863 | yes |
| 29 | 62.916 | 53.872 | 0 | no |

Summary: median overhead **15.696 ms**; p95 overhead **68.576 ms**. Latency thresholds **pass**.

## Earlier harness failures (not counted as evidence)

Two pre-authorization harness attempts failed separately (runtime-closure ENOENT on missing framework paths; then `-p`/profile and path-canonicalization defects). They produced no manifest hash and are not merged into the authorized run above.

## Review boundaries

This document is redacted. Raw NDJSON transcripts, stderr stacks, sentinel values, usernames, absolute temp paths, environment secrets, and the full private evidence tree remain outside Git. Reviewers may reconcile case counts, latency samples, grant inventory roles, manifest hash, and terminal status against the private manifest at `<PRIVATE_EVIDENCE_DIR>`.

## Decision

Terminal status: **NO-GO**

Rule applied: N1 requires every required allow/deny case to pass and cleanup to be confirmed. On this host, deny cases for forbidden read/write, loopback TCP, and Unix sockets passed, but **mirror-read-write**, **descendant-inheritance**, **timeout-process-group**, and **output-capture** failed because sandboxed children could not append case evidence under the compiled profile (EPERM on `<PRIVATE_EVIDENCE_DIR>` child files) and could not spawn the timeout grandchild (EPERM). Cleanup was therefore unconfirmed. Latency median (15.696 ms) and p95 (68.576 ms) were within budget but do not override the security-case failures.

Native unknown execution via Seatbelt on this recorded host is not authorized. Ordinary exact approval remains in place. No production driver, ADR-007, or Workstream C plan is created by this result.
