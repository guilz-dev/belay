# Native Seatbelt boundary probe result

## Current terminal status

**BLOCKED**

Authorized run #6 did not start a sandboxed child. The fixture failed while binding its Unix
socket, before any containment case or latency sample ran. This is a startup-harness result, not
evidence for or against Seatbelt containment.

- Invocation: `pnpm probe:native-seatbelt-boundary`
- Probe commit: `e9cf45b` (`fix: make N1 Seatbelt evidence fail closed`)
- Failure phase: private fixture listener startup
- Stable failure class: `listen EINVAL`
- Sandboxed child started: **no**
- Required cases completed: **0/10**
- Latency pairs completed: **0/30**
- Evidence manifest SHA-256: **none**
- Docker was neither inspected nor invoked.

The generated fixture root used the long per-user value returned by `os.tmpdir()`. Appending
`listeners/probe.sock` exceeded macOS's Unix-domain socket path limit, so `net.Server.listen()`
returned `EINVAL`.

## Authorized-run history

Earlier results are retained as harness history. They are not substituted for the latest blocked
run and do not authorize N2.

| Attempt | Manifest | Recorded outcome | Review status / root cause |
| --- | --- | --- | --- |
| Pre-auth #1–2 | none | harness failure | Missing profile flag and path canonicalization defects |
| Authorized #1 | `5d313611…` | NO-GO | Evidence directory was granted as a literal instead of a subpath |
| Authorized #2–4 | various | NO-GO / GO | Invalid harness evidence; #4 placed the cleanup marker outside the sandbox write grant |
| Authorized #5 | `415bbf6b…` | NO-GO | Invalid terminal rationale: a marker written before timeout was mistaken for post-cleanup survival; skipped runtime dependencies and implicit broad grants were not gated |
| **Authorized #6** | **none** | **BLOCKED** | **Unix socket path exceeded the macOS limit before the first sandboxed child** |

## Correction prepared after #6

Commit `925bddb` (`fix: shorten native probe socket path`) makes macOS fixture creation use the
short `/tmp/belay-native-seatbelt-probe-` prefix while retaining a mode-0700 private tree. A unit
test proves the resulting socket path remains below 104 characters. Focused verification after
the fix is 66/66 passing; typecheck and lint pass, with the same 10 pre-existing unrelated lint
warnings.

This correction has **not** been executed as another live probe. Per the one-run evidence rule,
it requires a separately authorized run #7. A future run must preserve #6 in this table rather
than replacing it.

## Review boundary

The failed startup created a private temporary fixture but no raw evidence manifest. Its absolute
path, generated sentinels, username-bearing temporary prefix, and copied fixture files are not
committed. No case observation, grant inventory, host identity, runtime closure, or latency value
from an earlier attempt is presented as run #6 evidence.

## Decision

Rule applied: N1 is **BLOCKED** when the authenticated local environment cannot execute the probe.
Because run #6 stopped before containment execution, it cannot be called GO or NO-GO.

Ordinary exact approval remains in place. N2, ADR-007, Workstream C, and production Seatbelt code
must not proceed unless a separately authorized, reviewed N1 run returns GO.
