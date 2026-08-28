# Native Unknown Shell Execution Program

> **Status:** Feasibility-gated. Do not implement the native execution boundary until the Cursor transport probe in this program passes and its design is approved.

**Goal:** Let Cursor complete eligible unknown repo-local Shell actions through a recoverable native boundary, without Docker, without executing the original command twice, and with a Belay opt-out.

**Why this is a program rather than one implementation plan:** The reported `make test-fast` incident contains two independent defects that can be fixed now. Native unknown execution also depends on a host capability that Belay has not yet proved: replacing a Cursor Shell command while preserving ordinary stdout, stderr, and exit status. Mixing all three changes into one implementation would conceal that dependency and make rollback and review harder.

## Fixed product decisions

- Docker is completely outside this feature. Do not probe it, invoke it, inspect it, or fall back to it, even when installed and configured.
- “Recoverable” initially means changes to files inside one repository only. It does not include services, databases, cloud APIs, sockets, credentials, package-manager state, or arbitrary host paths.
- Belay must not infer reversibility from an unknown command string and then run it on the host.
- An eligible command may execute once only after a fresh native boundary is established. The source workspace must remain untouched until observed changes pass policy and a durable recovery checkpoint exists.
- Failure before native execution starts returns to the existing exact-approval path.
- Failure after native execution starts must never cause automatic host replay. If discard and cleanup are verified, a later retry may use the existing exact-approval path; if cleanup is uncertain, Belay blocks replay to avoid duplicate external effects.
- Native mediation is opt-out. The intended end-state setting is `policy.unknownLocalExecution.enabled`, defaulting to `true` only on adapters and platforms whose complete contract is supported. `false` skips all probing and uses ordinary approval.
- Cursor is the first adapter. Claude Code and Codex retain ordinary approval until equivalent result-preserving mediation is proven for their hook contracts.

## Verified feasibility boundary

Cursor documents `preToolUse` as an allow/deny hook with `updated_input`; `deny` blocks the tool and there is no output field for synthesizing a completed Shell result:

- <https://prod.cursor.com/docs/hooks>
- <https://prod.cursor.com/docs/reference/third-party-hooks>

Therefore the old design—execute inside the hook and return `permission: deny`—cannot satisfy the user-visible behavior. It necessarily appears as a blocked tool. Returning `allow` without rewriting would execute the original command a second time.

The only currently plausible transport is:

1. `preToolUse` classifies the original action.
2. For an eligible action, Belay creates a short-lived, single-use execution ticket and returns `permission: allow` with `updated_input.command` set to a Belay-owned ticket runner.
3. Cursor runs that replacement as the actual Shell tool, so its stdout, stderr, and exit status remain the normal tool result.
4. The ticket runner atomically consumes the ticket and performs native isolated execution, observed-diff validation, checkpoint creation, apply, and cleanup.

Official documentation does not establish all semantics Belay needs: whether rewritten Shell input re-enters hooks, how `beforeShellExecution` interacts with it, whether exit status is preserved unchanged, and whether another matching hook can override the rewrite. Those are release-blocking facts, not implementation details.

## Workstreams

### A. Incident correction — implement independently

Execute [2026-08-28-cursor-make-action-cwd.md](./2026-08-28-cursor-make-action-cwd.md).

This plan fixes:

- Cursor `preToolUse: Shell` using the hook process cwd instead of the action cwd.
- Make resolution omitting `.PHONY` and `_`-prefixed prerequisite recipes.
- The exact regression in which `_start_test_deps` concealed Docker-affecting commands.

It does not add native execution and can merge regardless of the feasibility result.

### B. Result-preserving Cursor transport — mandatory spike

Execute [2026-08-28-cursor-shell-rewrite-feasibility.md](./2026-08-28-cursor-shell-rewrite-feasibility.md).

The spike must run against an actual supported Cursor Agent version, record the version and raw event transcript, and produce one of these decisions:

| Probe result | Decision |
|---|---|
| Rewrite executes once, normal output/exit is preserved, and all hook interactions are controllable | Proceed to ADR/design review |
| Rewrite is ignored, original also runs, output/exit is not preserved, or recursion cannot be controlled | Stop native mediation; ship only workstream A |
| Other matching hooks can override the Belay rewrite without detection | Stop default-on design; redesign conflict detection before proceeding |
| Result depends on an undocumented version range | Pin a tested minimum Cursor version and fail closed to ordinary approval outside it |

### C. Native boundary — create a new implementation plan only after B passes

Do not treat the following as implementation-ready tasks. They are acceptance constraints for ADR-007 and the later plan.

#### Authorization model

- The original unknown host action remains `require_approval`; native eligibility must not become a second classifier or a boolean bypass around EffectPlan.
- Lower mediation into a separate generated action/world, such as `native_observed_repo_execution`, with explicit capabilities: read an approved runtime closure, write only an execution mirror, no network, no control-plane access, and no source-workspace access.
- Evaluate that generated action through EffectPlan policy. The ticket authorizes only that exact generated action, not the original command and not a command-name allowlist.
- Increment `GATE_CONTRACT_VERSION` only if exported `GateVerdict` or `GatedAction` changes. Cursor-only response adaptation should remain outside the stable gate contract where possible.

#### Ticket contract

- Store ticket bodies outside the repository and execution mirror with owner-only permissions.
- Put only an opaque ticket id in the rewritten command; never put the original command, environment, or secrets in argv.
- Bind a ticket to action fingerprint, repository identity, action cwd, adapter, Cursor session/tool-use id, runtime version, and a short expiry.
- Validate without consuming in any secondary pre-execution hook; atomically consume immediately when the runner starts. Replay, expiry, mismatch, and missing state fail to ordinary approval before execution.

#### Native containment

- macOS support requires a fresh signed Seatbelt probe immediately before execution. `host-integration` is never enough.
- Always execute in a private file-checkpoint mirror; never expose the original workspace or Git common directory.
- Do not grant broad read access to `/opt/homebrew`, `/usr/local`, the home directory, or `/`. Build and attest a minimal runtime closure. If the closure cannot be determined without broad secret exposure, the action is ineligible.
- Deny network and Unix sockets. Treat subprocesses as inheriting the same boundary.
- Exclude sensitive files from the mirror rather than relying on path-only diff checks after their contents have already been read.

#### Completion and fallback

| Stage | Outcome |
|---|---|
| Boundary/ticket unavailable before runner start | Original action uses ordinary exact approval |
| Runner started; command exits nonzero or times out; cleanup verified | Return the real failure; store a retry receipt that permits ordinary exact approval on the next original attempt |
| Runner started; no repository change | Return the command’s real exit status; cleanup mirror |
| Runner started; safe repository diff | Create durable checkpoint, apply diff, return real exit status, cleanup mirror |
| Runner started; unsafe/uncertain diff; cleanup verified | Return a clear nonzero mediation failure; next original attempt may ask for exact approval |
| Runner started; cleanup or external-effect status uncertain | Return failure and suppress automatic/exact replay until manual review |

#### Configuration and latency

The later plan must add and document:

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

- `enabled: false` performs no probe, mirror, or ticket work.
- Omitted `enabled` normalizes to `true` only for a supported Cursor/macOS cohort; it must normalize to unavailable/approval on other cohorts.
- `maxPrepareMs` is a hard pre-start fallback to ordinary approval. `maxFinalizeMs` stops new apply work and records a latency failure after execution, but cleanup and source-integrity checks must still run to completion even when that budget is exceeded; Belay must not trade safety for a faster response.
- Measure total added wall time from hook receipt through runner completion. Release reporting must separate prepare, execute, validate/checkpoint/apply, and cleanup time; a preparation-only benchmark is insufficient.

#### Required conformance pairs

Every new allow/mediation case requires a paired must-ask case in the same test change:

- MUST-MEDIATE: unknown command changes only a non-sensitive repo file.
- MUST-ASK: the same shape addresses a repo-external path.
- MUST-MEDIATE: eligible command exits nonzero without changes and reports the real status.
- MUST-ASK: native boundary is unavailable before start.
- MUST-MEDIATE: valid fresh single-use ticket.
- MUST-ASK: expired, replayed, wrong-cwd, wrong-fingerprint, or wrong-session ticket.
- MUST-MEDIATE: explicit minimal runtime closure.
- MUST-ASK: closure requires a broad home, `/usr/local`, `/opt/homebrew`, or root read grant.
- MUST-MEDIATE: feature omitted/defaulted on a supported cohort.
- MUST-ASK: `enabled: false` or unsupported cohort.

## Delivery order and review gates

1. Merge workstream A by itself.
2. Run workstream B and review its evidence. Do not combine the probe commit with production policy code.
3. If B passes, write ADR-007 plus a domain-context update and obtain design review before implementation.
4. Write a separate native-boundary implementation plan with exact files, tests, and no code placeholders.
5. Implement behind the opt-out and a Cursor/platform cohort guard.
6. Integrate the separate `fix/cursor-host-denial-observability` work only after its commit is available; resolve overlap deliberately and run the combined runtime suite.

## Program definition of done

- Workstream A’s paired regression tests pass.
- Workstream B has a reproducible raw transcript and an explicit go/no-go result.
- No production native mediation code is merged before a passing probe and approved ADR.
- Docker is absent from the native execution call graph and tests prove it is never consulted.
- If the feasibility gate fails, the program closes honestly with ordinary exact approval retained; it does not ship a hook-time execution that appears as a denial.
