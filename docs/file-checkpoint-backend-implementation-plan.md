# Recovery v2: file-checkpoint backend implementation plan

Status: **Complete (Recovery v2, 2026-08)** — CoW snapshot backends remain future work.  
Scope: dirty Git worktrees first, non-Git workspace roots second  
Depends on: Recovery v1 checkpoint/receipt/restore path, transactional diff evaluator,
attested isolated workspace-mount boundary
Roadmap: Horizon 1 — CoW and dirty/non-Git file-checkpoint backends

## 1. Outcome

Add a `file_checkpoint` L2 backend that can safely observe and apply repository-local
filesystem changes when the current `git_worktree` backend cannot run:

1. a Git repository already has staged, unstaged, deleted, or untracked changes;
2. the workspace root is not managed by Git.

The backend must preserve the user's current filesystem state as the recovery
pre-image. It must execute the candidate command in an isolated filesystem mirror,
judge the observed diff, and apply only that diff to the real workspace after a
full TOCTOU preflight. A durable checkpoint must restore the workspace to the state
that existed immediately before the candidate command, including pre-existing dirty
changes.

This is not a backup-after-execution feature. The real workspace must not be mutated
until the observed diff has passed policy evaluation and a durable checkpoint has
been prepared.

## 2. Product behavior

### 2.1 Backend selection

| Workspace state | Selected backend | Initial default |
|---|---|---|
| Clean Git worktree | `git_worktree` | Existing behavior |
| Dirty Git worktree | `file_checkpoint` | Opt-in; durable checkpointing and isolated workspace mount required |
| Non-Git workspace | `file_checkpoint` | Separate opt-in; durable checkpointing and isolated workspace mount required |
| Unsupported file type, quota overflow, or inconsistent snapshot | None; fail closed | Always |

Selection is deterministic. `auto` does not fall back from a failed backend after a
candidate command has started. Backend probing and snapshot preparation happen before
execution; any failure returns a recovery-specific `deny_pending_approval` result.

Unlike the clean-Git backend, `file_checkpoint` is eligible only when both
`policy.transactional.fileCheckpoint.enabled` and
`policy.transactional.checkpoint.enabled` are true. A dirty/non-Git baseline cannot rely
on `HEAD` as a recovery source, so applying without a durable checkpoint would violate
the product's reversibility claim.

It is also eligible only when the selected boundary driver attests that it can mount the
execution mirror at the original workspace path without exposing the original host
workspace. Changing `cwd` alone is not isolation: an absolute path, `../`, shell
expansion, or an inherited environment variable could otherwise mutate the real
workspace before observation. The initial implementation supports the container driver;
host integration remains ineligible until a seatbelt/landlock-equivalent driver provides
the same property.

### 2.2 User-visible examples

Given a dirty Git workspace:

```text
README.md       user edit already present
src/new.ts      untracked user file
```

If the candidate command changes only `package.json`, Belay applies only
`package.json`. `README.md` and `src/new.ts` stay byte-for-byte unchanged. Restoring
the checkpoint restores the pre-command `package.json` while retaining the user's
dirty state.

If the candidate command also modifies `README.md`, the checkpoint pre-image for that
path is the user's dirty version, not `HEAD`. Restore returns to that dirty version.

For a non-Git workspace, the configured workspace root is treated as the recovery
resource root. The same observe, verify, apply, and restore rules apply.

## 3. Non-goals

- Undoing network, remote Git, database, process, IPC, environment-variable, service,
  or repository-external effects.
- Treating prediction as proof that an external effect is recoverable.
- Copying or restoring Belay's control-plane state as application data.
- Applying changes to Git metadata such as `.git/index`, refs, configuration, hooks,
  or object databases.
- Supporting submodules, nested repositories, filesystem devices, sockets, FIFOs,
  or hard-linked files in the first release.
- Preserving xattrs, ACLs, ownership, sparse files, or platform-specific forks in the
  first release. These limitations must be stated in the guarantee table.
- Making the backend default-on before dogfood data establishes acceptable latency
  and failure rates.

## 4. Safety invariants

These are implementation and test invariants, not advisory goals.

1. **No real mutation before observation.** The candidate command runs only in the
   execution mirror.
2. **No writes before complete preflight.** Every affected real path must still match
   the recorded baseline before the first apply write occurs.
3. **Existing dirty state is the baseline.** Git `HEAD` is not the pre-image for dirty
   paths.
4. **Exact path closure.** Every created, modified, deleted, type-changed, or
   mode-changed repository-local node must appear in the observed change set.
5. **No symlink traversal.** Directory walking and apply/restore operate on symlink
   nodes and never follow them.
6. **No partial successful apply.** Apply either verifies the complete post-state or
   rolls all touched paths back. Failed rollback becomes `needs_manual_repair`.
7. **Durable-before-write.** When durable checkpoints are enabled, manifest, pre-image
   blobs, state, and directory metadata are fsynced before real workspace mutation.
8. **Receipt-required restore.** `applied`, `restoring`, `restored`, and `conflict`
   checkpoints require a valid receipt.
9. **External effects remain blocked.** Any capability request rejected by
   `capabilityRequestsBlockRecovery` makes this backend ineligible.
10. **Unsupported semantics fail closed.** Unsupported node types, nested Git metadata,
    quota overflow, inconsistent copies, or inability to prove the baseline must not
    fall through to direct host execution.
11. **One-shot human restore.** Restore continues to require the signed out-of-band,
    exact, atomically consumed approval implemented by Recovery v1.
12. **Cleanup cannot rewrite the outcome.** Failure to remove temporary mirrors or
    append audit data after a verified apply is reported as an operational warning,
    not as a failed apply.
13. **Durable recovery is mandatory for this backend.** `file_checkpoint` must not apply
    to a real workspace when durable checkpointing is disabled.
14. **The original workspace is not reachable during candidate execution.** The backend
    must require an attested isolated workspace mount. `cwd` remapping, token inspection,
    or command rewriting is not an acceptable substitute.

## 5. Architecture

### 5.1 High-level flow

```text
Gate runtime
    |
    v
Recovery eligibility (capabilities + config)
    |
    v
Backend selector
    | clean Git                 | dirty Git / non-Git
    v                           v
git_worktree backend       file_checkpoint backend
    |                           |
    |                     baseline mirror (immutable)
    |                           |
    |                     execution mirror (writable)
    |                           |
    |                     isolated workspace mount
    |                  mirror -> original guest path
    |                           |
    +------------- execute candidate command
                                |
                         collect observed diff
                                |
                         shared diff evaluator
                                |
                   dangerous ---+--- safe
                       |                 |
                   discard         prepare durable checkpoint
                                         |
                                all-path TOCTOU preflight
                                         |
                                transactional apply + verify
                                         |
                                receipt + applied state
```

The two mirrors are necessary. A single writable mirror loses the original bytes when
the command overwrites a file. The immutable baseline supplies both TOCTOU expectations
and durable recovery pre-images.

### 5.2 Backend interface

Introduce an internal backend contract in
`src/core/transactional/backend.ts`:

```ts
export type TransactionalBackendId = 'git_worktree' | 'file_checkpoint'

export interface TransactionalBackendProbe {
  eligible: boolean
  backend: TransactionalBackendId
  reason?: string
  signals: string[]
}

export interface TransactionalSnapshot {
  backend: TransactionalBackendId
  resourceRoot: string
  executionRoot: string
  executionCwdRelative: string
  guestResourceRoot: string
  baselineRoot?: string
  resourceIdentity: string
  baselineTreeHash: string
  excludedRoots: string[]
  copyStrategy?: 'clonefile' | 'reflink' | 'copy'
  collectChanges(): Promise<ObservedFileChange[]>
  cleanup(): Promise<void>
}

export interface TransactionalBackend {
  id: TransactionalBackendId
  probe(context: TransactionalBackendContext): Promise<TransactionalBackendProbe>
  prepare(context: TransactionalBackendContext): Promise<TransactionalSnapshot>
}
```

`runner.ts` must depend on this contract rather than directly calling Git helpers.
The existing Git implementation moves behind `git-worktree-backend.ts` without a
behavior change in the first refactoring PR.

`executionRoot` is a host path used only as the boundary mount source.
`guestResourceRoot` is the original canonical workspace path as seen inside the isolated
runtime. Commands therefore retain absolute workspace-path semantics without gaining
access to the original host directory.

### 5.3 Observed filesystem model

Add `src/core/transactional/file-tree.ts` with a canonical, sorted tree index:

```ts
export type SnapshotNode =
  | { kind: 'absent' }
  | { kind: 'file'; mode: number; size: number; hash: string }
  | { kind: 'symlink'; target: string; hash: string }
  | { kind: 'directory'; mode: number; hash: string }

export interface FileTreeEntry {
  relativePath: string
  node: Exclude<SnapshotNode, { kind: 'absent' }>
}

export interface FileTreeIndex {
  version: 1
  entries: FileTreeEntry[]
  treeHash: string
  fileCount: number
  directoryCount: number
  totalFileBytes: number
}

export interface ObservedFileChange extends TransactionalFileChange {
  before: SnapshotNode
  after: SnapshotNode
}
```

Rules:

- Paths use exact NUL-safe relative path strings; never trim them.
- Do not Unicode-normalize names. On platforms where a directory entry cannot round-trip
  through Node's UTF-8 path representation, reject the backend rather than aliasing two
  byte names.
- Entries are sorted by bytewise relative path before hashing.
- Regular files are hashed using a streaming SHA-256 implementation.
- File mode participates in the node hash.
- A symlink hash covers the link target text; the target is not followed.
- Directory mode and empty-directory existence participate in the tree hash.
- A change of node kind is represented as one `modified` change with different
  `before.kind` and `after.kind`.
- Root `.git` metadata and configured Belay-managed roots are copied only where
  required for command semantics, but excluded from the observable/applicable tree.
- Exclusion does not mean “ignore writes.” Root `.git` is covered by the separate Git
  metadata fingerprint. Belay-managed roots are absent/read-only in the mirror and are
  scanned after execution; creating or changing one produces an observed protected-path
  rejection.
- A nested `.git` file or directory, hard link (`nlink > 1`), socket, FIFO, device,
  or unreadable node aborts snapshot preparation in the initial release.

Directory nodes require a Recovery manifest v2; silently ignoring empty directories
would make `effectClosure: repo_local_fs_observed` false.

### 5.4 File mirror construction

Add `src/core/transactional/file-checkpoint-backend.ts`.

Temporary layout:

```text
${os.tmpdir()}/belay-file-checkpoint-<random>/
  owner.json
  baseline/
  execution/
  baseline-index.json
```

`owner.json` contains version, PID, creation time, canonical resource root, and backend.
Startup reconciliation removes staging owned by dead processes. Live-process staging
must never be removed based only on age.

#### Dirty Git preparation

1. Resolve and record Git repository identity and current `HEAD`.
2. Reject recovery-blocking capability requests before filesystem work.
3. Reject nested repositories/submodules in the initial release.
4. Create an independent local clone in `baseline/` using
   `git clone --local --no-hardlinks --no-checkout -- <root> <baseline>`.
5. Remove all remotes from the clone so a command cannot write back through a local
   `origin` path.
6. Copy the current visible worktree into `baseline/`, excluding root `.git` and
   Belay-managed roots. Because the clone has no checkout, deleted tracked paths remain
   absent and untracked/ignored files are copied exactly.
7. Copy the source worktree index, resolved by `git rev-parse --git-path index`, into
   the standalone clone so staged/unstaged command semantics are preserved. Any command
   that changes Git metadata in the execution mirror is still treated as an unsupported
   observed effect and is not applied.
8. Build and persist the canonical baseline tree index.
9. Re-index the real visible worktree and require its tree hash to match the baseline.
   A concurrent change during preparation aborts before execution.
10. Clone `baseline/` to `execution/` with the filesystem copy primitive below.

The clone must not use hardlinks or Git alternates. `git count-objects` data is not part
of the recovery proof. Git metadata exists only to preserve local command behavior and
is never copied back.

If the source uses a split index, copy the shared-index file reported by
`git rev-parse --shared-index-path` as well. Reject unsupported index extensions rather
than silently rebuilding the index. Before command execution, record a compact Git
metadata fingerprint covering `HEAD`, resolved refs, index/shared-index, config,
`packed-refs`, and worktree administrative files. Recompute it afterward. A change to
that fingerprint produces `file_checkpoint_git_metadata_changed`; object files created
without a ref/index/config change are discarded with the mirror and do not count as an
applied effect.

#### Non-Git preparation

1. Treat the adapter-resolved workspace root as `resourceRoot`.
2. Compute directory identity from canonical path plus root `dev`, `ino`, and
   `birthtimeMs`.
3. Copy the visible root to `baseline/`, excluding Belay-managed roots.
4. Build the baseline index and compare it with a fresh real-root index.
5. Clone `baseline/` to `execution/`.

The initial non-Git release requires `cwd` to be inside the workspace root. It must not
silently remap an outside `cwd` to the root.

#### Copy primitive

Add `src/core/transactional/file-clone.ts`:

1. Try `copyFile(..., COPYFILE_FICLONE_FORCE)` for each regular file so success or
   fallback is observable.
2. Fall back to normal `copyFile` when clonefile/reflink is unsupported.
3. Preserve mode and atime/mtime; do not preserve ownership.
4. Recreate symlinks from `readlink` without dereferencing.
5. Create directories parent-first with their recorded mode.
6. Limit concurrency to a small fixed/configured value.
7. Enforce file-count, source-byte, total workspace, and preparation-time budgets during
   traversal. Total workspace accounting includes standalone Git metadata and both
   mirrors even though Git metadata is excluded from the observed application diff.
8. Detect copy-destination path collisions (including case-folding collisions) and fail
   closed.

The selected strategy is recorded as a probe signal and audit field. It does not change
the semantic guarantee.

### 5.5 Isolated workspace execution

Extend the boundary contract before enabling `file_checkpoint`:

```ts
export interface BoundaryWorkspaceMount {
  hostSourceRoot: string
  guestTargetRoot: string
  cwdRelative: string
  writable: boolean
  hideHostSourcePath: boolean
}

export interface BoundaryRunOptions {
  mountReadOnly?: boolean
  workspaceMount?: BoundaryWorkspaceMount
}

export interface BoundaryAttestation {
  // existing fields omitted
  isolatesWorkspaceMounts?: boolean
}
```

Required semantics:

- The execution mirror is mounted at `guestTargetRoot`, which equals the canonical
  original workspace path.
- The process working directory is `guestTargetRoot/cwdRelative`.
- The original host workspace is not mounted and is not reachable through
  `hostSourceRoot`, the original absolute path, parent traversal, or inherited bind
  mounts.
- The driver sanitizes `PWD`, `OLDPWD`, and Belay-internal host-path variables before
  execution. Environment variables intentionally supplied by the user remain subject to
  the boundary; they must not grant host filesystem reachability.
- The execution mirror is writable. Other host filesystem paths are absent or
  read-only according to the driver's attested policy.
- Network behavior remains governed by the existing egress boundary and is not made
  recoverable by this backend.

Container implementation:

```text
docker run
  --mount type=bind,src=<executionRoot>,dst=<originalResourceRoot>
  --workdir <originalResourceRoot>/<cwdRelative>
  ...
```

Docker bind mounts are writable by default. For a read-only workspace mount, append the
valid `readonly` option; do not append the unsupported bare `rw` field.

Do not additionally mount the original workspace. Validate both mount paths before
constructing Docker arguments. The container driver must compare `guestTargetRoot` with
its trusted canonical resource root, then reject a mount source that equals or contains
that root. The container image must contain the command's runtime dependencies; a
missing runtime produces a normal non-zero execution result and no apply.

`host-integration` reports `isolatesWorkspaceMounts: false`. Backend selection returns
`file_checkpoint_isolation_unavailable` rather than executing on the host. Future
seatbelt/landlock/Cursor-sandbox drivers may opt in only after conformance tests prove
the same mount and reachability semantics.

Eligibility uses a fresh, signature-verified boundary attestation, not only the configured
driver name. Extend `ResolvedBoundaryDriverContext` with the verified attestation and its
freshness result. A missing, stale, tampered, or `isolatesWorkspaceMounts !== true`
attestation fails before snapshot preparation and instructs the operator to run
`belay session start`. Tests may inject a signed fixture; production code must not infer
isolation from `sandbox.runtime` alone.

### 5.6 Shared transactional runner

Refactor `runTransactionalExecution` into backend-independent orchestration:

```ts
const backend = await selectTransactionalBackend(context)
const snapshot = await backend.prepare(context)
const shellResult = await boundary.run(command, snapshot.executionRoot, timeout, {
  workspaceMount: {
    hostSourceRoot: snapshot.executionRoot,
    guestTargetRoot: snapshot.guestResourceRoot,
    cwdRelative: snapshot.executionCwdRelative,
    writable: true,
    hideHostSourcePath: true,
  },
})
const changes = await snapshot.collectChanges()
const observed = evaluateTransactionalDiff(changes, diffContext)

if (observed.verdict !== 'allow') return observedRisk(...)

const checkpoint = checkpointEnabled
  ? await prepareRecoveryCheckpointFromObservedChanges(snapshot, changes)
  : null

await applyObservedChanges({ snapshot, changes, checkpoint })
```

The orchestration preserves these current behaviors:

- non-zero command exit or timeout never applies a diff;
- observed-dangerous changes return `transactional_observed_risk`;
- an observed-safe apply returns `transactional_already_applied`, preventing host
  re-execution;
- backend, proof hash, checkpoint ID, and observed assessment are written to audit.

Backend cleanup runs in `finally` and is best effort after a completed outcome.

### 5.7 Apply engine

Extract the filesystem portions of `git-worktree.ts` into
`src/core/transactional/apply-observed-changes.ts`.

Apply algorithm:

1. Validate all relative paths and reject path escape.
2. For every change, compare the real node with `change.before` from the immutable
   baseline. Do this for all paths before any write.
3. Re-check every parent component and reject symlink/non-directory parents.
4. Capture rollback snapshots for all affected real paths.
5. Apply directory additions parent-first.
6. Apply file/symlink additions and modifications.
7. Apply file/symlink deletions.
8. Apply directory deletions child-first using non-recursive `rmdir`; a non-empty
   directory is a conflict, not a recursive deletion.
9. Verify every real path against `change.after`.
10. Write the Recovery receipt and transition to `applied` while rollback data remains
    available.
11. On any error, restore rollback snapshots in reverse order and verify the complete
    baseline state.

This engine must also replace the current Git-specific apply path so both backends share
identical TOCTOU, symlink, mode, ordering, rollback, and verification behavior.

### 5.8 Recovery manifest v2

Recovery v1 cannot represent directories. Add a backward-compatible manifest union:

```ts
export type RecoveryCheckpointManifest =
  | RecoveryCheckpointManifestV1
  | RecoveryCheckpointManifestV2

export interface RecoveryCheckpointManifestV2 {
  version: 2
  checkpointId: string
  backend: RecoveryBackend
  repoRoot: string
  resourceKind: 'git_repository' | 'directory'
  repoIdentity: string
  commandFingerprint: string
  createdAt: string
  expiresAt: string
  proof: RecoveryProofV1
  entries: RecoveryCheckpointEntryV2[]
}

export type RecoveryFileSnapshotV2 =
  | RecoveryFileSnapshotV1
  | { kind: 'directory'; mode: number; hash: string }
```

Compatibility decisions:

- Readers and restore accept manifest v1 and v2.
- New checkpoints from either backend emit v2 after the reader lands.
- State and receipt formats remain version 1 because they bind the complete manifest
  hash and do not interpret node kinds.
- `proof.baseStateHash` is the hash of the sorted changed-path pre-images, not the whole
  workspace. The whole baseline tree hash is recorded in `probeSignals`/audit metadata,
  but not required to restore changed paths.
- `file_checkpoint` proofs include `file_mirror_baseline`, plus `dirty_git` or
  `non_git_workspace`, and the selected copy strategy.
- Directory restore never recursively removes content that was not in the manifest.

`checkpoint.ts` should be split while implementing v2:

```text
src/core/recovery/artifact-store.ts    manifest/state/receipt I/O and validation
src/core/recovery/snapshot-node.ts     capture, hash, compare, apply node
src/core/recovery/reconcile.ts         crash reconciliation
src/core/recovery/restore.ts           conflict check and restore transaction
src/core/recovery/checkpoint.ts        compatibility exports/orchestration
```

Do not combine the split with unrelated public API changes.

### 5.9 Resource identity

Move identity logic into `src/core/recovery/resource-identity.ts`:

- Git repository: canonical root, resolved Git metadata path, and metadata directory
  `dev`/`ino`/`birthtimeMs`.
- Non-Git directory: canonical root and root directory `dev`/`ino`/`birthtimeMs`.

Restore verifies identity before reading approval state or writing repository files.
A directory/repository recreated at the same path must not accept an old checkpoint.

### 5.10 Configuration

Extend `policy.transactional` without changing current defaults:

```json
{
  "policy": {
    "transactional": {
      "enabled": true,
      "fileCheckpoint": {
        "enabled": false,
        "allowNonGit": false,
        "maxFiles": 100000,
        "maxSourceBytes": 2147483648,
        "maxWorkspaceBytes": 4294967296,
        "prepareTimeoutMs": 30000,
        "copyConcurrency": 8
      }
    }
  }
}
```

Meanings:

- `enabled`: allows dirty-Git backend selection.
- `allowNonGit`: separately enables non-Git roots after the dirty-Git path is stable.
- `maxSourceBytes`: maximum visible source file bytes.
- `maxWorkspaceBytes`: maximum logical baseline plus execution-mirror bytes. Physical
  disk usage may be lower when clonefile/reflink succeeds, but eligibility never depends
  on that optimization.
- `maxFiles`: includes regular files, symlinks, and directories.
- `prepareTimeoutMs`: snapshot preparation budget, separate from command timeout.
- `copyConcurrency`: bounded file-copy concurrency; clamp to a safe range during config
  normalization.

The existing `policy.transactional.checkpoint.maxBytes` remains the durable recovery
artifact quota. Temporary mirror budgets and durable artifact quotas are intentionally
separate.

Config normalization must supply defaults for old files. `config-schema.md`, config
tests, wizard/status output, and `doctor` must expose the new fields.

### 5.11 Status, audit, and diagnostics

`belay recover status` should report:

```json
{
  "availableBackends": ["git_worktree", "file_checkpoint"],
  "fileCheckpoint": {
    "enabled": true,
    "allowNonGit": false,
    "isolation": "container",
    "copyStrategy": "clonefile",
    "probe": "available"
  }
}
```

Add audit fields:

- `transactionalBackend`
- `resourceKind`
- `baselineTreeHash`
- `snapshotFileCount`
- `snapshotSourceBytes`
- `snapshotWorkspaceBytes`
- `snapshotCopyStrategy`
- `snapshotPrepareMs`
- `recoveryCheckpointId`
- `recoveryProofHash`
- `recoveryState`

Add stable failure reasons:

```text
file_checkpoint_disabled
file_checkpoint_non_git_disabled
file_checkpoint_durable_checkpoint_required
file_checkpoint_isolation_unavailable
file_checkpoint_cwd_outside_root
file_checkpoint_nested_repository
file_checkpoint_unsupported_node
file_checkpoint_hardlink_unsupported
file_checkpoint_quota_exceeded
file_checkpoint_prepare_timeout
file_checkpoint_source_changed
file_checkpoint_git_metadata_changed
file_checkpoint_copy_failed
```

Failure messages must contain counts/limits but not sensitive filenames unless the
existing redaction policy permits them.

`doctor` performs a small temporary clone/copy probe and reports support for clonefile,
reflink, or copy fallback. It must not copy the real repository during doctor.

## 6. Detailed implementation sequence

Each pull request is a tracer bullet that remains shippable and keeps current defaults.

### PR 1 — Backend contract and current Git adapter

Files:

- Add `src/core/transactional/backend.ts`.
- Add `src/core/transactional/backend-selector.ts`.
- Add `src/core/transactional/git-worktree-backend.ts`.
- Refactor `runner.ts` to use the contract.
- Keep `file_checkpoint` disabled/unimplemented.

Acceptance:

- Existing transactional and Recovery v1 tests are unchanged or mechanically moved.
- Clean Git behavior, audit reasons, and timing fields remain compatible.
- Backend selection unit tests cover clean Git, dirty Git, and non-Git probes.

### PR 2 — Isolated workspace boundary contract

Files:

- Extend `BoundaryRunOptions` and `BoundaryAttestation` with isolated workspace-mount
  semantics.
- Implement mirror-to-original-path mounting in `boundary-driver-container.ts`.
- Make `host-integration` explicitly report that it cannot isolate workspace mounts.
- Load and signature-verify a fresh boundary attestation in the resolved driver context.
- Add selector failure reason `file_checkpoint_isolation_unavailable`.

Acceptance:

- An absolute path equal to the original workspace root resolves to the mirror inside
  the container.
- The original host workspace is unchanged when commands use absolute paths, `../`,
  `OLDPWD`, or known host-path environment variables.
- The mirror remains writable and its diff is observable after execution.
- No original-workspace bind mount appears in the generated container arguments.
- Host integration cannot select `file_checkpoint`.
- Missing, stale, or tampered boundary attestations cannot select `file_checkpoint`.

### PR 3 — Canonical file-tree and clone primitives

Files:

- Add `file-tree.ts` and `file-clone.ts`.
- Add exact-path, streaming hash, exclusion, quota, and owner-marker utilities.

Acceptance:

- Round-trip regular files, executable modes, symlinks, directories, empty directories,
  and leading/trailing-space filenames.
- Never follow directory symlinks.
- Reject nested `.git`, hardlinks, sockets/FIFOs/devices, unreadable nodes, path escape,
  and quota overflow.
- Detect changes even when size and timestamp are preserved.
- Dead-owner staging is collected; live-owner staging is retained.

### PR 4 — Shared apply engine and TOCTOU repair

Files:

- Add `apply-observed-changes.ts`.
- Move reusable snapshot-node functions out of `git-worktree.ts`.
- Convert the existing Git backend to supply exact baseline expectations.

Acceptance:

- All affected paths are preflighted before the first write.
- A concurrent edit to any affected path produces zero real mutations.
- Type changes, directory ordering, rollback, and post-state verification are tested.
- Cleanup/audit failure after verified apply cannot turn success into rejection.

This PR closes the current Git path's weaker “capture hashes after isolated execution”
window before the new backend depends on the shared engine.

### PR 5 — Recovery manifest v2

Files:

- Add v2 manifest/node types and backward-compatible readers.
- Split `checkpoint.ts` into artifact, node, reconcile, and restore modules.
- Add directory-aware apply/restore ordering.

Acceptance:

- Existing v1 fixture restores successfully.
- V2 file, symlink, directory, mode, addition, deletion, and type-change checkpoints
  restore successfully.
- Missing/tampered receipt, blob, manifest, or directory hash fails before real writes.
- Crash states reconcile to `prepared`, `applied`, `restored`, `conflict`, or
  `needs_manual_repair` without guessing.

### PR 6 — Dirty Git file-checkpoint backend

Files:

- Implement `file-checkpoint-backend.ts` dirty-Git preparation.
- Add config, normalization, status, doctor, and audit fields.
- Wire backend selector fallback from dirty Git to `file_checkpoint` only when enabled.

Acceptance scenarios:

- Staged, unstaged, deleted, untracked, ignored, executable, and symlink baseline state.
- Command changes an already-dirty file; restore returns to the dirty pre-command bytes.
- Command changes a clean file while unrelated dirty files remain unchanged.
- Observed risky diff is discarded with no real mutation.
- Git metadata change in the execution mirror is rejected and not applied.
- Concurrent source change during prepare or apply fails closed.
- Absolute workspace paths mutate only the execution mirror.
- An unavailable/unattested isolation driver fails before command execution.
- Restore uses signed exact one-shot approval and cannot be replayed concurrently.

### PR 7 — Non-Git workspace support

Files:

- Add directory resource identity.
- Extend selector and config with `allowNonGit`.
- Update adapter/root and CLI diagnostics where they assume a Git repository.

Acceptance scenarios:

- Plain directory add/modify/delete/type/mode changes.
- Nested `cwd` inside the root is mapped exactly.
- Outside-root `cwd` is rejected.
- Directory replacement at the same path invalidates old checkpoints.
- Nested repositories and unsupported filesystem nodes fail closed.

### PR 8 — Dogfood, performance, and documentation

**Status: delivered.**

Work:

- Add performance counters and report aggregation (`belay metrics` schema v4 recovery section).
- Update README, SECURITY, ROADMAP, CONTEXT, config schema, and guarantee table.
- Mark the already-implemented approval cache/standing-allow item as delivered in
  ROADMAP while updating Horizon 1 backend status.
- Dogfood dirty Git with feature flag; keep non-Git separately gated.

Promotion criteria:

- No observed false negatives in the adversarial corpus.
- No apply/restore data-loss incident.
- Snapshot prepare p95 and failure reasons are measured on real workspaces.
- Quota/unsupported-node failures are understandable enough that users do not disable
  the transactional layer.

## 7. Test matrix

### 7.1 Unit tests

| Area | Required cases |
|---|---|
| Tree index | deterministic ordering, exact spaces, Unicode, mode, symlink, directory, empty directory |
| Clone | clonefile/reflink success, copy fallback, partial-copy cleanup, quotas, timeout |
| Diff | add, delete, modify, type change, mode-only change, directory topology |
| Path safety | `..`, absolute paths, NUL, parent symlink, nested metadata |
| Identity | Git metadata replacement, directory inode replacement, wrong root |
| Manifest | v1 compatibility, v2 canonical hash, directory validation, receipt validation |
| Apply | global preflight, ordered writes, rollback, rollback verification, cleanup failure |
| Selector | clean Git, dirty Git enabled/disabled, non-Git enabled/disabled, blocked capability |
| Boundary | guest path mapping, original-root hiding, cwd mapping, environment sanitization, unattested rejection |

### 7.2 Integration tests

Use real temporary repositories/directories and real shell execution:

1. dirty Git baseline plus safe command delta;
2. dirty file modified again, then restored to its dirty baseline;
3. staged and unstaged changes coexist;
4. untracked and ignored files required by the command exist in the mirror;
5. dangerous deletion count is observed and never reaches the real workspace;
6. command timeout/non-zero exit discards the mirror;
7. TOCTOU between observation and apply leaves every target untouched;
8. crash after manifest, after `applying`, after writes, and after receipt;
9. two restore attempts with one approval yield exactly one restore;
10. shared control plane keeps per-resource quotas independent;
11. non-Git directory apply and restore;
12. repository/directory recreated at the same path rejects restore;
13. absolute original-workspace paths resolve to the mirror and leave the host root
    untouched;
14. host integration/unattested drivers fail before candidate execution.

### 7.3 Conformance and regression

- Add L2 scenarios for dirty Git and non-Git to the layer conformance matrix.
- Add a boundary conformance scenario proving that the original host workspace is not
  reachable while the writable mirror is mounted at the guest workspace path.
- Keep MUST-ASK and MUST-ALLOW corpus gates at zero regressions.
- Assert that recovery-blocking capability requests never select `file_checkpoint`.
- Run build, typecheck, lint, complete Vitest suite, and packaging smoke tests.

## 8. Rollout and compatibility

1. Land readers for manifest v2 before any writer emits v2.
2. Keep both new flags false by default.
3. Enable dirty Git in maintainer dogfood repositories with an attested container
   workspace boundary.
4. Observe prepare latency, quota failures, unsupported-node failures, apply conflicts,
   and cleanup leaks.
5. Enable non-Git dogfood separately.
6. Consider changing presets only after the guarantee table and operational metrics
   match actual behavior.

Existing v1 artifacts remain readable until their normal retention expiry. No bulk
migration is needed. Configuration normalization must make old config files equivalent
to both new flags being disabled.

## 9. Definition of done

**Status: complete (Recovery v2, 2026-08).** CoW snapshot backends remain explicitly out of scope.

Recovery v2 is complete when all of the following are true:

- Dirty Git workspaces can run eligible local mutations through L2 without discarding or
  overwriting pre-existing changes.
- Non-Git workspaces can opt into the same behavior.
- The candidate command never mutates the real workspace before observed-diff approval.
- Absolute paths and parent traversal cannot escape the isolated execution mirror; an
  unattested driver cannot run this backend.
- Durable restore returns every affected path to its exact pre-command filesystem node,
  including directory and mode state covered by the manifest.
- Concurrent edits fail before the first apply write.
- Unsupported filesystem or Git-metadata effects fail closed with stable diagnostics.
- Recovery v1 manifests remain readable.
- Signed exact one-shot restore approval remains mandatory.
- Status, audit, doctor, docs, and guarantee tables describe the backend and its limits.
- Full CI, conformance, corpus, and packaging checks pass.

## 10. First implementation task

Start with **PR 1: backend contract and current Git adapter**. Do not begin by copying
files. The backend seam must land first so file-checkpoint development does not add a
second orchestration path with different failure, audit, approval, or cleanup semantics.

The first PR should introduce no product behavior change and should be reviewable by
comparing existing clean-Git integration test outputs before and after the refactor.
