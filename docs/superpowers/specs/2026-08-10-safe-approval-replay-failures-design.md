# Safe Approval Replay Failures Design

## Goal

Make one-step approval replay failures accurate and non-exfiltrating: raw process output must not enter agent-facing messages, timeouts must never count as success, and unconfirmed container cleanup must be reported as a potentially still-running execution.

## Decisions

1. Agent-facing replay-lifecycle messages contain only Belay-generated structured facts: exit code, timeout state, and cleanup state. Captured `stdout`, `stderr`, thrown exception messages, approval-store errors, and audit errors are never copied into `user_message`.
2. Container cleanup failure uses a typed `BoundaryCleanupError` with the stable discriminator `code: 'BOUNDARY_CLEANUP_UNCONFIRMED'`, `resourceKind: 'container'`, `executionStarted: true`, and `cleanupConfirmed: false`. The generated resource identifier is independently validated for display and shown only when it matches `belay-run-<UUID>`; otherwise the cleanup failure is still recognized but the message omits the identifier. The error does not expose Docker output.
3. Approval replay succeeds only when `exitCode === 0` and `timedOut === false`.
4. A cleanup error receives a distinct audit reason and an operator-facing message that says the command started, the container may still be running, and manual inspection/removal is required.

## Components and Data Flow

- `src/core/process-runner.ts` continues to capture bounded output for internal diagnostics and Docker absence detection.
- `src/core/capability/boundary-run.ts` defines `BoundaryCleanupError`, `isBoundaryCleanupError`, and a separate safe resource-identifier formatter. The type guard checks the stable discriminator and cleanup-state fields; the formatter independently allowlists `belay-run-<UUID>` for display. This keeps the cleanup-failure contract at the boundary abstraction without coupling gate runtime to the Docker driver or relying only on `instanceof` across bundle boundaries.
- `src/core/capability/boundary-driver-container.ts` throws `BoundaryCleanupError` only after a timed-out execution has started and container absence cannot be confirmed.
- `src/adapters/shared/gate-runtime.ts` distinguishes cleanup failures from pre-start failures, never includes raw error/process text in agent-facing messages, and rejects all timed-out results regardless of exit code.

## Error Handling

- Caught approval-claim, pre-start replay, and audit exceptions produce fixed Belay messages without exception text.
- Boundary cleanup exceptions produce a `started, but cleanup could not be confirmed` message and include the generated container identifier only when it passes the display allowlist.
- Ordinary non-zero exits and timeouts produce structured failure messages without output excerpts.
- One-shot approvals remain consumed and are never re-armed after any replay attempt.

## Testing

- Verify arbitrary token-shaped stderr is absent from replay failure messages.
- Verify approval-claim, thrown pre-start, and audit errors do not expose their exception messages.
- Verify `{ exitCode: 0, timedOut: true }` returns `continue: false`, records a replay-failed audit rather than replay-succeeded, and cannot reuse or re-arm the one-shot approval.
- Verify `BoundaryCleanupError` returns `continue: false`, produces the distinct `approval_replay_cleanup_unconfirmed` audit reason, accurately says execution started and cleanup is unconfirmed, and cannot reuse or re-arm the one-shot approval.
- Verify only a `belay-run-<UUID>` resource identifier is included in operator guidance; invalid or untrusted identifiers are omitted without changing the cleanup-failure classification.
- Verify the container driver throws the typed cleanup error when removal and absence confirmation fail.
- Run targeted tests, type checking, lint, and the complete test suite.

## Scope

This change does not persist process output, add a diagnostic log, expand credential-pattern matching, or change command execution policy. Those require separate storage, retention, and threat-model decisions.
