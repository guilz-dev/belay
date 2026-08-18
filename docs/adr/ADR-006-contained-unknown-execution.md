# ADR-006 — Contained execution for unknown local effects

- Status: Accepted
- Date: 2026-08-18
- Related: [ADR-004](./ADR-004-effectplan-shell-authority.md) and
  [ADR-005](./ADR-005-command-allowlist-prohibition.md)

## Context

Some repository-local shell actions remain `unknown_local_effect` after canonical
normalization. Treating a familiar executable, command prefix, fingerprint, or corpus
entry as safe would create a second shell authority and regress to a command allowlist.
Improving command grammar remains the right response when semantics can actually be
proven, but it cannot safely turn every indeterminate local command into a known effect.

## Decision

For a narrowly eligible `unknown_local_effect`, Belay may execute the command once in a
verified disposable Docker boundary. This is an opt-in Docker-only v1 execution route;
it mediates an already-unknown plan and always blocks the original host invocation.

EffectPlan remains the sole shell authority. Contained-route eligibility is determined
from the gated shell action and the canonical EffectPlan's location, opacity, effect
requirements, and risk signals. It does not grant eligibility from an executable name,
command prefix, fingerprint, corpus membership, or ecosystem identity; command allowlists remain
prohibited.

The route uses a fresh signed contained-execution capability. Session start resolves and
binds the configured Docker binary, local Unix daemon endpoint, daemon identity, image
reference, and immutable image ID. At execution the current reference must still resolve
to that signed image ID. The container has no network, a read-only root, a bounded
writable `/tmp`, no ambient host environment, no daemon logging, and configured CPU,
memory, PID, and timeout limits.

The current workspace is copied to a metadata-free, bounded `file_copy` mirror. Only the
mirror is mounted, at the original absolute guest workspace path. The source workspace,
Git metadata/common directory, Belay control plane, Docker socket, devices, and unrelated
host paths are not mounted. The mirror is discarded after the one command; there is no
diff, apply, checkpoint, or host replay.

This route is not grant materialization and not L1-full. A contained capability does not
imply `materializesGrants`, `deniesUngrantedEffects`, or an adversarial same-user claim.

## Fallback taxonomy

- In audit mode, Belay's contained route reports `wouldMediate: true` and performs no contained
  execution: it reads no attestation and prepares neither a mirror nor a container. The gate
  returns `allow`, so the host hook delegates the original invocation as ordinary audit
  pass-through; it is not a contained-route host replay.
- Before any container start, only typed Docker substrate or daemon unavailability falls
  back to the ordinary `unknown_local_effect` approval path.
- Missing, stale, tampered, or mismatched capability/image; mirror or lease failure;
  create/inspect failure or timeout; attempted start; command timeout; and unconfirmed
  container or mirror cleanup all fail closed. They never approve or replay the host
  command.
- A contained command that exits nonzero is reported as contained failure and receives no
  approval. Its workspace changes are discarded just like a zero-exit run.

## Consequences

- Operators provision the image and Docker substrate themselves; v1 never builds or pulls
  an image automatically and never grants egress.
- Unknown Rails, RSpec, and fictional commands take the same effect-based route when they
  meet the eligibility constraints. No framework decoder or exception is introduced.
- The copy-only mirror intentionally supersedes the early detached-worktree design. It
  applies to clean, dirty, and non-Git current state and avoids exposing host Git hooks,
  filters, fsmonitor, or common-directory metadata to the guest.
- Docker/kernel trust, hostile same-OS-user races, nested mounts, network filesystems, and
  crash-orphan cleanup residuals remain outside this v1 guarantee.
