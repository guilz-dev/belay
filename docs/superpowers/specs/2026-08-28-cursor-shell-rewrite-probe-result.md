# Cursor Shell rewrite probe result

- Invocation: `cursor-agent --print --output-format stream-json --trust --workspace <private temporary workspace> <controlled prompt>`.
- Cursor executable version captured at preflight: `2026.08.11-e8db854`. Hook payloads report `2026.08.11-e8db854` for Case A and `2026.08.25-3e8eec8` for Cases B--E; this in-run version drift is material evidence, not normalized away.
- Host platform: macOS host; the harness captured Node platform `darwin`, Darwin kernel `25.5.0`, and architecture `arm64`. It did not capture a macOS product-version string, so the Darwin kernel is not recorded as one.
- Stream initialization reported model `Composer 2.5 Fast` and permission mode `default` for every actual case.
- Actual-run raw-evidence manifest SHA-256: `1307f62fdec93b4ecc6f570a343527c9425ceca1f29dfd9884d2edbfb766d407`.
- User-level `.cursor/hooks.json`: present (SHA-256 `a3598b14e70a4a9532cc87ce4e881f503488d66c6b20d080c62f745ade91e0f9`); its contents were neither copied nor modified.

## Earlier sandbox-blocked startup (not a rewrite run)

This earlier attempt is recorded separately and is not evidence about command replacement.

- Preflight version and authentication commands exited successfully, but every case process exited 1 before emitting a stream event or invoking a hook.
- Across Cases A--E (including all E variants): zero hook invocations, zero Shell calls, and no marker files. It therefore made no rewrite attempt and yields no transport result.
- Blocked-startup raw-evidence manifest SHA-256: `c90c1bd6b39d5d556dc76c02f4c16da5233ca419a9d8d3a643ee444c53ff52e6`.

## Actual authorized run

All seven actual case processes exited 0 with a successful terminal stream event and no malformed stream lines. The completed Shell call was nevertheless recorded as rejected in every case. No original, mediated, or third marker file exists in any case.

### Case A -- replacement and single execution

- `preToolUse` saw the original command once and returned a mediated replacement; it was not reinvoked with that replacement.
- `beforeShellExecution` received the mediated command and allowed it.
- The completed Shell result rejected the mediated command with an empty reason. No mediated stdout marker reached the stream, and neither marker file was created.

### Case B -- exit and stderr propagation

- `preToolUse` again replaced the original command, and `beforeShellExecution` observed and allowed the mediated command.
- The mediated fixture would write the exact stderr marker and exit 37, but the completed Shell result rejected it with an empty reason before execution. Consequently, neither exit code 37 nor the stderr marker propagated, and no original command ran.

### Case C -- secondary-hook interaction

- `preToolUse` replaced the original command; `beforeShellExecution` received the mediated command and allowed it.
- The completed Shell result rejected the mediated command with an empty reason, so no marker or execution output propagated.
- The fixture established replacement visibility at the secondary hook, but it used a nonce-bearing probe command rather than a runner ticket. It does not demonstrate ticket validation without consumption; that remains an unobserved runner-protocol invariant.

### Case D -- competing `updated_input`

- In this one run/configuration, the competing-mode `preToolUse` log and response came first, the normal-mode log and response came second, and both hooks received the original command.
- `beforeShellExecution` then received the third command, not the mediated command, and denied it. The completed Shell result was a visible rejection and no marker was created.
- This is an observed sequence amid the in-run Cursor-version drift only. Deterministic precedence remains unestablished.

### Case E -- denied and invalid hook responses

- **Deny:** `preToolUse` returned `permission: deny`; there was no `beforeShellExecution` invocation, no marker, and the completed Shell result visibly rejected the original command.
- **Malformed:** `preToolUse` emitted malformed output; there was no `beforeShellExecution` invocation, no marker, and the completed Shell result visibly rejected the original command. The observed behavior blocked this case rather than executing it.
- **Nonzero:** `preToolUse` exited nonzero, yet `beforeShellExecution` still received the original command and also exited nonzero. No marker was created, and the completed Shell result rejected the original command with an empty reason. A nonzero `preToolUse` response therefore did not itself prevent downstream secondary-hook delivery in this run; because both hooks exited nonzero, execution fail-open behavior for one failed hook remains unisolated and unresolved.

## Review boundaries

These are redacted observations from the one authorized actual run and its separately retained manifest. Raw streams, hook payloads, timestamps, local paths, account information, session/conversation/tool identifiers, tokens, and transcripts remain private.

## Decision

The native Cursor Shell rewrite transport is rejected for this proposal. The decision rule requires every Case A--D transport requirement to pass, while the authenticated actual run established the following decisive failures:

- **A failed execution and stdout propagation:** `beforeShellExecution` received and allowed the mediated replacement, but that command did not execute and its stdout marker did not reach the stream.
- **B failed exit-status and stderr propagation:** the mediated fixture's exit 37 and stderr marker did not propagate; the original command did not execute.
- **C proved replacement visibility only:** the secondary hook observed the replacement, but ticket validation without consumption and single runner consumption were not exercised.
- **D did not establish deterministic precedence:** one competing replacement sequence was detected and denied, but the observation occurred amid hook-payload version drift and cannot establish stable precedence or conflict behavior.

Case E visibly rejected the deny and malformed variants, but execution fail-open behavior for a single nonzero hook remains unresolved. That uncertainty is an additional design risk; it is not needed to reach the decision because Cases A--D already fail their required invariants.

This result is not blocked: the supported-host invocation recorded above was authenticated, ran with permission mode `default`, reached the hooks, and produced sufficient evidence for NO-GO. Cursor's official CLI reference says [`--force` force-allows commands unless explicitly denied](https://docs.cursor.com/en/cli/reference/parameters), while its permissions reference says [`--force` is required for writes in print mode](https://docs.cursor.com/cli/reference/permissions). A `--force` run therefore changes the permission regime and is not evidence for the ordinary approval transport evaluated here.

The ordinary exact one-shot approval path remains in place. The native execution proposal is closed without adding its configuration option. This decision does not create ADR-007 or a Workstream C plan and requires no production runtime, adapter SDK, or gate-contract change.

- Terminal status: **NO-GO**
