# Explicit Native Unknown Execution Transport Design

- Status: Approved for feasibility work only
- Date: 2026-08-30
- Related: [ADR-004](../../adr/ADR-004-effectplan-shell-authority.md), [ADR-005](../../adr/ADR-005-command-allowlist-prohibition.md), [ADR-006](../../adr/ADR-006-contained-unknown-execution.md)
- Prior evidence: [Cursor Shell rewrite probe result](./2026-08-28-cursor-shell-rewrite-probe-result.md)

## Decision summary

Belay will not predict that an unknown command is reversible and will not run that command in
the source workspace. The original Cursor Shell action remains denied. A future Cursor adapter
may instead issue an opaque, signed, short-lived, single-use ticket and invite the agent to call a
Belay-owned local MCP tool. That tool would execute the command once inside a freshly probed native
boundary, inspect the resulting private-mirror diff, and apply only an observed-safe repository
change after creating a durable recovery checkpoint.

This design is gated by two independent probes:

1. **N1 — native Seatbelt boundary:** prove that the current macOS substrate can enforce the
   required filesystem, process, network, socket, inheritance, cleanup, and latency properties.
2. **N2 — Cursor deny-to-tool continuation:** only after N1 passes, prove that an actual supported
   Cursor Agent responds to a denied Shell action by calling the Belay MCP tool exactly once and
   then continues correctly from its structured result.

No ADR-007, production configuration, adapter change, or Workstream C implementation plan may be
created until both probes are GO and their evidence has passed review.

## Why the order changed after the rewrite NO-GO

The previous proposal depended on `updated_input.command` replacing Cursor's Shell invocation. The
authenticated probe established that Cursor delivered the replacement to a secondary hook but did
not execute it or preserve its output and exit status. That transport is closed as NO-GO.

An MCP tool avoids Shell rewriting, but it is only a transport. It does not stop an unknown program
from reading credentials, opening sockets, or changing unrelated host state. Proving Cursor's tool
continuation before proving the native boundary would therefore validate a route that Belay still
could not safely use. N1 precedes N2.

## Product invariants

1. EffectPlan remains the sole shell authority. An executable name, Make target, prefix,
   fingerprint, framework, prior success, or corpus membership never authorizes execution.
2. The original unknown action remains `require_approval` and is never replayed automatically on
   the host.
3. The isolated execution is a separate generated action/world with narrower authority: exact
   runtime reads, private-mirror reads and writes, inherited process execution, and no network or
   unrelated host access.
4. The command executes at most once per ticket. Boundary failure before start uses ordinary exact
   approval; failure after start cannot trigger automatic replay.
5. The source workspace and canonical Git common directory remain inaccessible during execution.
6. Docker is absent from this feature: no discovery, version check, daemon inspection, image use,
   fallback, or documentation prerequisite.
7. Unsupported platforms and missing native substrates fail closed to ordinary exact approval.
8. `host-integration` is not a containment boundary and cannot satisfy N1.
9. Sensitive paths are excluded from the private mirror before execution; post-execution diff
   filtering is not a substitute for preventing the read.
10. Probe evidence and eventual runtime output are scrubbed and bounded before user-visible storage.

## N1 boundary contract

N1 is a real-host substrate probe, not a production `BoundaryDriver`. It uses a private temporary
fixture tree and `/usr/bin/sandbox-exec` on macOS. The probe must not read or alter a user's actual
repository contents beyond loading the probe program itself.

The generated Seatbelt profile starts with `deny default`. It may grant only:

- exact process-execution paths required by the fixture;
- exact runtime files and library paths discovered for those executables;
- read/write access beneath the private execution mirror;
- the minimum literal device and system resources empirically required to start the fixture; and
- inherited stdout/stderr descriptors used by the parent probe.

It must not grant a subpath read for `/`, the user's home directory, `/usr/local`, or
`/opt/homebrew`. An exact executable or exact library beneath those roots may be granted as a
literal when its path and SHA-256 are recorded in the evidence. Any required broad grant makes N1
NO-GO.

The live cases are:

| Case | Expected observation |
|---|---|
| mirror read/write | Fixture reads and changes only a sentinel beneath the mirror |
| source workspace | Read and write attempts fail; source sentinel is unchanged |
| fake home secret | Read and write attempts fail; secret is absent from captured output |
| Belay control plane | Read and write attempts fail; control sentinel is unchanged |
| unrelated absolute path | Read and write attempts fail |
| loopback TCP | Connection fails and the parent listener accepts zero connections |
| Unix socket | Connection fails and the parent listener accepts zero connections |
| descendant inheritance | A spawned child repeats forbidden read/write/socket attempts and all fail |
| timeout | The complete process group is terminated and no descendant marker appears afterward |
| output | stdout, stderr, exit code, signal, and timeout state are captured and scrubbed |

The probe runs 30 paired no-op samples with and without Seatbelt after five warm-ups. N1 requires
the Seatbelt-only overhead to have median no greater than 100 ms and p95 no greater than 250 ms on
the recorded host. Mirror preparation and command duration are reported separately and are not
hidden inside the boundary-overhead number.

### N1 decision

- **GO:** every required allow/deny case passes, descendants inherit the boundary, cleanup is
  confirmed, no broad grant is present, and both latency limits pass.
- **NO-GO:** a forbidden effect succeeds, a required broad grant is needed, cleanup is uncertain,
  a descendant escapes, or either latency limit is exceeded.
- **BLOCKED:** the host is not macOS, `/usr/bin/sandbox-exec` is absent, or the authenticated local
  environment cannot execute the probe. BLOCKED is not GO.

N1 output consists of a redacted result document, the exact host and executable identities, the
profile grant inventory, per-case observations, latency samples, and a SHA-256 manifest for the
private raw evidence directory. Raw evidence remains outside Git.

N1 does not add a `seatbelt` production driver or reuse its result as runtime authority. A future
production implementation must perform a fresh probe and bind its signed attestation to the exact
profile, runtime closure, repository identity, mirror root, Belay version, and expiry immediately
before issuing a ticket.

## N2 transport contract

N2 is specified now but planned only after N1 is GO. Its candidate tool is a project-local MCP
server named `belay` with a single execution entry point named `execute_unknown_once`.

The sequence is:

1. Cursor requests an unknown Shell action.
2. Belay classifies it from its canonical EffectPlan and denies the original tool invocation.
3. If the N1-derived native capability is available, Belay stores the command and normalized
   context outside the repository and returns only an opaque ticket id plus an instruction to call
   `belay.execute_unknown_once`.
4. Cursor calls the MCP tool with that ticket id. No command text, environment, or secret is placed
   in tool arguments.
5. The tool atomically claims the ticket, establishes a fresh native boundary, executes once in a
   private mirror, evaluates the observed diff, checkpoints and applies only an observed-safe
   change, verifies cleanup, and marks the ticket consumed.
6. The tool returns bounded `stdout`, `stderr`, `exitCode`, `timedOut`, `applied`, and
   `checkpointId` fields. Cursor must use that result and continue without retrying the original
   Shell action.

The ticket is signed and bound to:

- action fingerprint and EffectPlan hash;
- canonical repository identity and action cwd;
- adapter, Cursor conversation/session, and original tool-use correlation;
- Belay MCP server and tool identity;
- native boundary profile and runtime-closure hash;
- Belay runtime version, issue time, expiry, and random nonce.

Ticket state is `issued -> claimed -> consumed`. Validation that occurs before the MCP call does
not consume it. The MCP handler atomically moves `issued` to `claimed` immediately before starting
the isolated process. Any replay, mismatch, expiry, missing state, or non-`issued` state fails
without execution. Once `claimed`, no automatic retry is permitted even if the process or cleanup
fails.

### N2 decision

An actual supported Cursor Agent must demonstrate in one controlled run that:

- the original Shell command never executes;
- the MCP tool is called exactly once with the issued opaque ticket;
- denial does not end the agent turn before the tool call;
- stdout, stderr, nonzero exit, timeout, and applied/no-change states are understood;
- the agent continues its task after a successful tool result;
- the agent does not retry the original command after a tool failure;
- expired, altered, wrong-repo, wrong-cwd, wrong-session, and replayed tickets do not execute; and
- raw transcripts and Cursor/Belay/OS versions are recorded.

Failure of any item is NO-GO. Agent prose is not evidence; hook events, MCP invocations, marker
files, ticket state, and captured structured results are evidence.

## Observed-diff completion semantics

| Stage | Result |
|---|---|
| Ticket or boundary unavailable before claim | Deny and retain ordinary exact approval |
| Claimed; command exits nonzero or times out; cleanup verified | Return the real failure; do not replay |
| Claimed; no repository change | Return the real result and consume the ticket |
| Claimed; observed-safe repository diff | Create durable checkpoint, apply, verify, and return success |
| Claimed; unsafe or uncertain diff; cleanup verified | Return mediation failure; do not apply or replay |
| Claimed; cleanup or external-effect status uncertain | Fail closed and require manual review |

## Configuration contract after both probes pass

The feasibility work adds no configuration. The intended production option is:

```json
{
  "policy": {
    "unknownLocalExecution": {
      "enabled": true,
      "maxPrepareMs": 2000,
      "maxFinalizeMs": 2000
    }
  }
}
```

`enabled: false` is a complete opt-out: Belay performs no ticket, native probe, mirror, or MCP
mediation work and uses ordinary approval. A missing value may normalize to `true` only for a
future explicitly supported Cursor/macOS cohort. Every other adapter/platform combination remains
unavailable and uses ordinary approval. No state falls back to Docker.

## Deferred decisions

ADR-007 must decide these only after N1 and N2 evidence exists:

- whether the supported cohort can default to enabled or must remain opt-in;
- the production `BoundaryAttestation` schema and signature binding;
- whether a private file-checkpoint mirror is the only backend or a clean-Git optimization can
  preserve the same source/common-directory non-access guarantee;
- the exact MCP installation and conflict-detection mechanism;
- ticket persistence and crash-recovery retention; and
- release latency budgets including mirror creation, diff validation, checkpoint, apply, and
  cleanup.

## Definition of done for this design phase

- This design and the N1 probe plan are reviewed.
- N1 is executed once on the target macOS host and produces GO, NO-GO, or BLOCKED evidence.
- N2 is neither planned nor executed unless N1 is GO.
- ADR-007 and Workstream C remain absent unless both N1 and N2 are GO.

