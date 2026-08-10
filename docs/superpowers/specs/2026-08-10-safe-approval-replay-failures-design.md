# Safe Approval Replay Failures Design

## Goal

Make one-step approval replay failures accurate and non-exfiltrating: raw process output must not enter agent-facing messages, timeouts must never count as success, and unconfirmed container cleanup must be reported as a potentially still-running execution.

## Decisions

1. Agent-facing replay messages contain only Belay-generated structured facts: exit code, timeout state, and cleanup state. Captured `stdout` and `stderr` remain internal process-runner data and are never copied into `user_message`.
2. Container cleanup failure uses a typed `BoundaryCleanupError`. It records the safe resource kind and generated resource identifier, plus the fact that execution started and cleanup could not be confirmed. It does not expose Docker output.
3. Approval replay succeeds only when `exitCode === 0` and `timedOut === false`.
4. A cleanup error receives a distinct audit reason and an operator-facing message that says the command started, the container may still be running, and manual inspection/removal is required.

## Components and Data Flow

- `src/core/process-runner.ts` continues to capture bounded output for internal diagnostics and Docker absence detection.
- `src/core/capability/boundary-run.ts` defines `BoundaryCleanupError`, keeping the cleanup-failure contract at the boundary abstraction rather than coupling gate runtime to the Docker driver.
- `src/core/capability/boundary-driver-container.ts` throws `BoundaryCleanupError` only after a timed-out execution has started and container absence cannot be confirmed.
- `src/adapters/shared/gate-runtime.ts` distinguishes cleanup failures from pre-start failures, never includes raw error/process text in agent-facing messages, and rejects all timed-out results regardless of exit code.

## Error Handling

- Pre-start replay exceptions produce a generic `could not start` message without exception text.
- Boundary cleanup exceptions produce a `started, but cleanup could not be confirmed` message including only the generated container identifier.
- Ordinary non-zero exits and timeouts produce structured failure messages without output excerpts.
- One-shot approvals remain consumed and are never re-armed after any replay attempt.

## Testing

- Verify arbitrary token-shaped stderr is absent from replay failure messages.
- Verify thrown pre-start errors do not expose their message.
- Verify `{ exitCode: 0, timedOut: true }` is a replay failure.
- Verify `BoundaryCleanupError` produces the distinct audit reason and accurate operator guidance.
- Verify the container driver throws the typed cleanup error when removal and absence confirmation fail.
- Run targeted tests, type checking, lint, and the complete test suite.

## Scope

This change does not persist process output, add a diagnostic log, expand credential-pattern matching, or change command execution policy. Those require separate storage, retention, and threat-model decisions.
