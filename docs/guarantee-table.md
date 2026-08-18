# Layer guarantee table (v1.0)

This table states what belay guarantees **per configuration**. Adversarial
resistance is claimed **only** for the L1-full row when the external sandbox runtime
actually enforces deny-all (container / seatbelt / landlock / Cursor sandbox).

Machine-readable source: `src/conformance/guarantee-table.ts` and `src/conformance/guarantee-posture.ts`.  
Conformance tests: `src/__tests__/conformance/layer-matrix.test.ts`,
`src/__tests__/conformance/guarantee-table.test.ts`,
`src/__tests__/conformance/guarantee-posture.test.ts`.

**Configured vs attested:** `belay sandbox status` reports both `configuredProfile` (from config) and `attestedProfile` (from boundary attestation). L1-full adversarial guarantees apply only when both align (`l1FullAttested: true`). Run `belay session start` to refresh attestation after enabling container sandbox.

| Configuration | Layers active | Cooperative agent | Adversarial same-OS-user | Tested scenarios |
|---------------|---------------|-------------------|---------------------------|------------------|
| Default (L3+L4) | Prediction + approval | EffectPlan policy allows payload-free reads, flags reversible local mutation, and requires approval for payload sends and outside-repo mutation | Not protected — control plane and hooks are detect-only | `l3-allow-readonly`, `l3-allow-network-read`, `l3-allow-flagged-wget-output`, `l3-allow-flagged-git-fetch`, `l3-allow-flagged-git-pull`, `l3-deny-payload-send`, `l3-deny-secret-file-send`, `l3-deny-outside-repo` |
| L1 partial (egress) | Egress proxy + L3+L4 | Same shell semantics as L3, with an additional egress boundary when traffic is brokered | Not protected — proxy bypass / raw sockets remain | `l1p-allow-readonly`, `l1p-allow-network-read`, `l1p-allow-flagged-wget-output`, `l1p-allow-flagged-git-fetch`, `l1p-allow-flagged-git-pull`, `l1p-deny-payload-send`, `l1p-deny-secret-file-send`, `l1p-deny-outside-repo` |
| L2 (transactional) | Observed diff + L3+L4 | `allow_flagged` local mutations can be observed in a Git/file checkpoint before apply; remote and high-stakes effects remain ineligible | Not protected — snapshot-external effects remain | `l2-allow-readonly`, `l2-allow-network-read`, `l2-allow-flagged-wget-output`, `l2-allow-flagged-git-fetch`, `l2-allow-flagged-git-pull`, `l2-allow-flagged-dirty-git-file-checkpoint`, `l2-deny-payload-send`, `l2-deny-secret-file-send`, `l2-deny-outside-repo` |
| L1-full (sandbox + egress + isolation + signing) | Sandbox + egress broker + signed control plane + L3+L4 | Same shell semantics plus outer enforcement of network/filesystem scopes; external sends and outside-repo writes require approval | Protected **only** when OS sandbox enforces FS/network deny-all and control plane is on a separate trust domain | `l1f-allow-readonly`, `l1f-allow-network-read`, `l1f-allow-flagged-wget-output`, `l1f-allow-flagged-git-fetch`, `l1f-allow-flagged-git-pull`, `l1f-deny-payload-send`, `l1f-deny-secret-file-send`, `l1f-deny-outside-repo`, `l1f-deny-outside-repo-write` |

## Contained unknown execution (opt-in)

Contained unknown execution is a separate execution capability, not a fifth layer profile and
not an L1-full claim. The machine-readable profile table deliberately remains limited to the
four general configurations above; the contained route applies only to one eligible
`unknown_local_effect` after canonical EffectPlan classification.

When `sandbox.containedExecution.enabled` is configured and `belay session start` has produced a
fresh signed compatible capability, Belay guarantees for that one mediated run:

- Docker executes by an explicit absolute executable and local Unix socket, bound to the attested
  Docker binary hash, daemon identity, configured image reference, and immutable image ID.
- Network is always `none` in v1: there are no egress grants. The root filesystem is read-only;
  only bounded writable `/tmp` and the disposable mirror are available. CPU, memory, PID, and
  timeout limits are enforced; Linux capabilities are dropped, no-new-privileges is set, host
  environment/proxy variables are sanitized, and the log driver is `none`.
- The current state is copied to a metadata-free bounded `file_copy` mirror. Docker receives only
  this mirror at the original absolute guest workspace path. The declared mounts make the host
  source workspace, Git metadata/common directory, Belay control plane, Docker socket, devices,
  and unrelated host paths inaccessible through the contained command.
- The command starts at most once, its output is scrubbed and capped to 16 KiB tails, and both
  zero and nonzero exits discard mirror changes. Successful cleanup is confirmed before the route
  completes; cleanup uncertainty fails closed.

Audit mode records `wouldMediate` but does not prepare a mirror or execute a container. In enforce
mode, only typed pre-execution Docker substrate/daemon unavailability falls back to the existing
approval path. Missing/stale/tampered capability, image mismatch or absence, mirror/lease failure,
create/inspect/start failure, timeout, and cleanup failure deny without approval. A nonzero guest
exit is a contained failure, not an approval.

This does not protect against a hostile same-OS-user process racing observed paths, nested mounts,
network filesystem semantics, Docker/kernel vulnerabilities, or crash-orphan residuals. It does
not assert filesystem/network deny-all for arbitrary host execution and therefore must not be read
as an adversarial L1-full guarantee.

## L1-full prerequisites

All must be true for `belay sandbox status` to report `l1FullActive: true`:

1. `sandbox.enabled: true` with a real external sandbox runtime (`runtime` ≠ `none`)
2. `egress.enabled: true` and the egress proxy running for this repository
3. `controlPlane.isolation.mode` is `read-only-mount` or `separate-user`, verified by doctor
4. `approvalSigning.required: true`

Recommended starting point: `belay init --preset l1-full-recommended`.

## Capability broker resource scopes

| Capability | Broker mechanism | Resource-scoped approval |
|------------|------------------|--------------------------|
| Egress (HTTP/S) | Egress proxy with an approved domain scope | `belay approve <id> --scope domain` |
| FS outside repo | Sandbox/filesystem boundary with an approved path scope for brokered tool execution | `belay approve <id> --scope path --path <abs-path>` |

These persisted boundary scopes are resource grants, not command allowlists. They do not
replace the EffectPlan decision for normalized shell actions.

## Shell authorization authority

Normalized shell authorization is `EffectPlan` → PolicyEngine → projection
([ADR-004](./adr/ADR-004-effectplan-shell-authority.md)). Legacy command allow/deny lists,
corpus catalogs, and shell standing-allow records cannot change that projection.

Payload-free network reads with no other effects are `allow`; explicit payload/file/secret
sends and remote mutation require approval. A bare `wget` is `allow_flagged` because its
payload-free read also creates a local output file. `git fetch` and `git pull` are likewise
`allow_flagged` because they combine a network read with reversible local updates.
Outside-repository mutation requires approval. L1-full adds container filesystem/network
enforcement and attested resource grants without changing those shell semantics.

## What is never guaranteed

- Covert channels (DNS tricks, raw sockets, IPC) without OS sandbox enforcement
- Agent compliance when hooks are disabled or bypassed outside the IDE
- Protection when config promises L1-full but the sandbox runtime is not actually engaged

## Recovery surfaces

`belay report` and `belay recover advice` (also available as the backward-compatible
`belay recover` alias) are **read-only advisory** commands. A checkpoint receipt, not an
audit candidate, is the only executable recovery point.

| Surface | Behavior | Security note |
|---------|----------|---------------|
| `report` | Aggregates redacted `audit.ndjson` | No new classification; cannot widen allow |
| `recover` / `recover advice` | Suggests undo steps; does not run them | Advice is partial and does not prove the target action executed |
| `recover --command` | Re-runs shell classification for the given text | May invoke Tier1 judge (egress to Ollama/cloud); classification only |
| `recover status/list/show` | Inspects durable checkpoint artifacts | Does not mutate repository files; may durably reconcile checkpoint metadata after a crash |
| `recover apply <id>` | Restores an exact repo-local pre-image | Requires a signed out-of-band, expiring exact one-shot approval; refuses any post-state conflict |

Recovery suggestions are intentionally conservative: irreversible undo patterns (e.g.
`git reset --hard`) are never recommended. Operators must verify steps manually; recovery
commands themselves are subject to the same hooks if executed.

Recovery v1 covers only the observed repository-local filesystem diff. It does not undo
network, remote Git, database, process, IPC, environment, service, or repository-external
effects. Dirty and non-Git repositories do not receive checkpoints.
