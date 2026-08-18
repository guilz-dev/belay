# Contained Unknown Execution Implementation Plan

## Goal

Resolve eligible `unknown_local_effect` shell commands by executing them once inside a verified disposable Docker boundary, without command-name allowlists and without weakening EffectPlan authority. The feature is opt-in and falls back to the existing approval path whenever the boundary cannot be proven.

## Global invariants

- Do not add executable-name, prefix, fingerprint, corpus-membership, Rails, RSpec, Ruby, Bundler, Yarn, or Make-specific allow rules.
- Keep `EffectPlan` as the sole shell authority; contained execution mediates an unknown plan rather than reclassifying it as known-safe.
- Never execute the original host command after mediation.
- Never mount the source workspace, Git common directory, Belay control plane, Docker socket, devices, or unrelated host paths into the contained command.
- Runtime networking is always disabled in v1 and ambient host environment variables are not forwarded.
- Workspace mutations are always discarded. Cleanup failure is fail-closed.
- Existing users retain current behavior unless `sandbox.containedExecution.enabled` is explicitly true.

### Task 1: Add backward-compatible contracts and configuration

Use TDD to add `sandbox.containedExecution` with defaults: disabled, null image, 30s timeout, 2048 MiB memory, 2 CPUs, and 256 PIDs. Reject enabled configuration without a container runtime and explicit image. Add an optional contained-execution attestation capability carrying immutable image ID, network-none, isolated writable mirror, read-only root, sanitized environment, resource limits, probe time, and expiry. Validate this capability separately from existing full-boundary booleans so it cannot imply `materializesGrants` or L1-full. Add `MediatedExecutionResult` and optional `wouldMediate`/mediated result fields to the gate contract without breaking old serialized inputs. Extend process output capture to report truncation while retaining 16 KiB tails. Add focused tests for normalization, migration, stale/old/tampered capability rejection, contracts, and truncation.

### Task 2: Implement effect-based eligibility

Use TDD to add `isContainedUnknownExecutionEligible`. It must require a shell gate, enabled contained execution, `unknown_local_effect`, repo-local location, transparent or safely expanded recursive opacity, and concrete requirements limited to repo-local `process.exec`, `fs.read`, `fs.write`, and `indeterminate`. It must reject network, secrets, control-plane, outside-workspace paths, high-stakes/Tier0 effects, pipe-to-shell, dynamic evaluation, command substitution, and unparseable shell. It must not inspect executable names, prefixes, fingerprints, or corpus membership. Add tests using fictional commands plus Rails runner and RSpec dry-run, and a structural test preventing ecosystem-specific decoders/allow rules/corpus additions.

### Task 3: Build a disposable non-applying workspace mirror

> **Superseded backend decision (reviewed after Task 3):** The initial detached-worktree design
> below was replaced by a copy-only `file_copy` mirror for every workspace state. This is a
> security-positive change, not a silent rewrite: it supports clean, dirty, and non-Git current
> state without exposing host Git hooks, filters, fsmonitor, common-directory metadata, or source
> paths to the guest. The historical text remains for traceability.

Historical plan: use TDD to implement a contained-execution mirror abstraction. For a clean Git
repository, use a detached worktree but ensure Git metadata/common-directory paths are not exposed
to the guest. For dirty Git or non-Git repositories, copy the current working state into a temporary
mirror using existing transactional filesystem primitives where possible. Exclude `.git`, the
configured Belay control plane, and symlinks escaping the repository. Mount only the mirror at the
original absolute guest workspace path. Provide deterministic cleanup on success, nonzero exit,
timeout, and setup failure; expose a dedicated cleanup-unconfirmed error. Never diff or apply mirror
changes. Test dirty content visibility, source immutability, exclusions, outside symlinks, and every
cleanup path.

### Task 4: Add hardened contained Docker execution and attestation

Use TDD to implement a contained-only Docker route distinct from the existing grant-materializing route. Resolve the configured image reference to an immutable Docker image ID during `belay session start`, probe the actual boundary, and sign the contained capability. At execution, require a fresh signed capability and verify the configured reference still resolves to the signed image ID; execute using that ID. Arguments must include network none, read-only root, bounded writable `/tmp` tmpfs, cap-drop ALL, no-new-privileges, configured CPU/memory/PID limits, host UID/GID, and explicit `/bin/sh` entrypoint. Do not forward `process.env`, proxy variables, extra mounts, devices, or Docker socket. Return a deterministic enforcement receipt and hash. Test exact arguments, immutable-ID mismatch, stale/tampered/legacy attestation, missing image, timeout, cleanup, and (when Docker is available) inspect-based boundary properties.

### Task 5: Integrate mediation into the gate, audit, metrics, and explain

Use TDD to route eligible unknown shell commands after classification. Audit mode must not execute and must record/display `wouldMediate: true`. Enforce mode must prepare the mirror, execute exactly once in the contained boundary, deny the original host invocation, discard changes, scrub output, and return at most 16 KiB tails with truncation flags and receipt hash. Exit zero uses `contained_execution_complete`; nonzero uses `contained_execution_failed`; neither requests approval. Boundary unavailability before execution falls back to the existing `unknown_local_effect` approval path and never auto-allows host execution. Timeout, image mismatch after attestation, or cleanup-unconfirmed after an attempted execution must fail closed. Audit only receipt hash, image ID, mirror backend, and exit status—never raw stdout/stderr. Preserve exact one-shot approval outside the boundary. Test one-shot/no-double-run behavior, output handling, failures, audit mode, metrics, explain, and identical routing for fictional, Rails, and RSpec commands.

### Task 6: Document the security contract and add conformance coverage

Add an ADR recording why indeterminate commands are mediated by a verified execution boundary instead of command grammar. Update `docs/CONTEXT.md`, the execution boundary map, guarantee table, config schema, README, and changelog. Clearly state explicit image provisioning, session attestation, immutable image binding, no network, sanitized environment, discarded workspace changes, audit-mode non-execution, and fallback-to-approval behavior. Preserve and test the statements that EffectPlan remains shell authority and command allowlists are prohibited. Add Docker integration coverage proving no access to network, host source, control plane, or unrelated host paths when Docker is available.

### Task 7: Verify the complete change

Run focused tests after every task, then run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:structural`, `pnpm corpus`, and `pnpm probe:adversarial` on Node 22. Compare full-suite failures to the recorded baseline (25 failures across 9 files caused by existing timeouts, a missing ignored design file, and unavailable Ollama). Run the contained Docker integration suite when Docker is available. Request a final code review against this plan and resolve all blocking findings before completion.
