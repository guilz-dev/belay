# Recovery Manifest v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit Recovery checkpoint manifest v2, restore directory and type-change entries safely, and retain full read/restore compatibility with durable v1 artifacts.

**Architecture:** Keep `checkpoint.ts` as the stable public orchestration facade while extracting artifact validation, filesystem snapshot operations, resource identity, reconciliation, and restore transactions into focused modules. Both manifest versions flow through one discriminated union; only v2 permits directory snapshots, while state and receipt remain version 1 and continue binding the canonical manifest hash.

**Tech Stack:** TypeScript 5.9, Node.js 22 filesystem APIs, Vitest 3, Biome, pnpm.

## Global Constraints

- Existing exported Recovery function names and call signatures remain compatible.
- Readers, listing, reconciliation, approval binding, and restore accept manifest versions 1 and 2.
- New checkpoints emitted by the Git worktree backend use manifest version 2 and `resourceKind: 'git_repository'`.
- State and receipt formats remain version 1.
- A directory snapshot is `{ kind: 'directory'; mode: number; hash: string }`; its hash must bind the normalized mode.
- Before any restore write, validate the manifest, receipt, every referenced blob, every symlink hash, every directory hash, repository identity, expiry, state, and complete post-state.
- Directory restore must never recursively remove content not represented by manifest entries.
- Restore order is side-aware: absent targets deepest-first, directory targets shallowest-first, then file/symlink targets.
- Keep `file_checkpoint` backend selection fail-closed and unimplemented in this PR.

---

### Task 1: Manifest v2 types and compatibility exports

**Files:**
- Modify: `src/core/recovery/types.ts`
- Modify: `src/core/recovery/index.ts`
- Modify: `src/core/index.ts`
- Test: `src/__tests__/recovery-checkpoint.test.ts`

**Interfaces:**
- Produces: `RecoveryFileSnapshotV2`, `RecoveryCheckpointEntryV2`, `RecoveryCheckpointManifestV2`, and `RecoveryCheckpointManifest`.
- Preserves: `RecoveryCheckpointManifestV1` and `RecoveryFileSnapshotV1` unchanged for compatibility.

- [x] **Step 1: Write the failing type/runtime contract test**

Add a checkpoint test that runs the existing Git transaction and asserts the persisted manifest is version 2 with `resourceKind: 'git_repository'`. The production change that makes this test fail is continuing to emit v1.

```ts
const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
expect(loaded.manifest).toMatchObject({
  version: 2,
  backend: 'git_worktree',
  resourceKind: 'git_repository',
})
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run src/__tests__/recovery-checkpoint.test.ts -t "emits manifest v2"`

Expected: FAIL because the manifest currently has `version: 1` and no `resourceKind`.

- [x] **Step 3: Add the v2 discriminated union**

```ts
export type RecoveryFileSnapshotV2 =
  | RecoveryFileSnapshotV1
  | { kind: 'directory'; mode: number; hash: string }

export interface RecoveryCheckpointEntryV2 {
  path: string
  before: RecoveryFileSnapshotV2
  after: RecoveryFileSnapshotV2
}

export type RecoveryCheckpointEntry =
  | RecoveryCheckpointEntryV1
  | RecoveryCheckpointEntryV2

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

export type RecoveryCheckpointManifest = RecoveryCheckpointManifestV1 | RecoveryCheckpointManifestV2
```

Export the union and new v2 types from both public index modules. Update the prepared-checkpoint internal type to use the union and emit v2 with `resourceKind: 'git_repository'`.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run src/__tests__/recovery-checkpoint.test.ts -t "emits manifest v2"`

Expected: PASS.

### Task 2: Recovery snapshot-node extraction and directory behavior

**Files:**
- Create: `src/core/recovery/snapshot-node.ts`
- Modify: `src/core/recovery/checkpoint.ts`
- Test: `src/__tests__/recovery-checkpoint.test.ts`

**Interfaces:**
- Consumes: `RecoveryCheckpointEntryV1 | RecoveryCheckpointEntryV2` and `RecoveryFileSnapshotV1 | RecoveryFileSnapshotV2`.
- Produces: `captureRecoverySnapshot`, `withoutRecoveryBlob`, `recoverySnapshotMatches`, `validateRecoverySnapshot`, `applyRecoverySnapshot`, `recoveryStateHash`, and `sortRecoveryEntriesForSide`.

- [x] **Step 1: Write failing directory and type-change tests**

Add real-filesystem tests for these independent breaks. Use the exported prepare and
state-transition functions with explicit baseline/execution trees so empty directories
are observable even though Git does not track them:

```ts
const checkpoint = await prepareRecoveryCheckpoint({
  stateDir,
  repoRoot,
  worktreePath: executionRoot,
  commandFingerprint: 'fixture-command',
  changes: [{ relativePath: 'empty-dir', kind: 'added' }],
  config: { ...DEFAULT_RECOVERY_CHECKPOINT, enabled: true },
})
await mkdir(path.join(repoRoot, 'empty-dir'), { mode: 0o755 })
await markRecoveryCheckpointApplying(stateDir, checkpoint)
await markRecoveryCheckpointApplied(stateDir, checkpoint)
await writeFile(path.join(repoRoot, 'empty-dir', 'unmanifested.txt'), 'keep\n')

await expect(restoreRecoveryCheckpoint(stateDir, checkpoint.checkpointId)).rejects.toThrow()
await expect(readFile(path.join(repoRoot, 'empty-dir', 'unmanifested.txt'), 'utf8')).resolves.toBe(
  'keep\n',
)
expect((await showRecoveryCheckpoint(stateDir, checkpoint.checkpointId)).state.state).toBe(
  'applied',
)
```

Use analogous explicit entries for file-to-directory, directory-to-file, and directory
mode changes. Assert restored bytes, node kinds, and modes. The unmanifested child case
must refuse recursive removal, leave the child intact, and return to `applied` after the
captured post-state rollback verifies.

- [x] **Step 2: Run the three focused tests and verify RED**

Run: `pnpm vitest run src/__tests__/recovery-checkpoint.test.ts -t "directory|type-change"`

Expected: FAIL with `recovery_unsupported_file_kind` or incorrect restore ordering.

- [x] **Step 3: Implement directory-aware node primitives**

Use SHA-256 over `directory:${mode & 0o777}` for the directory hash. Capture directories without traversing children. Validation must recompute hashes from literal fields and reject missing/extra invalid fields. Applying a directory may replace a file or symlink, but removal of an existing directory must use `rm(..., { recursive: false })`; `ENOTEMPTY` is a safe failure.

Implement side-aware ordering:

```ts
export function sortRecoveryEntriesForSide(
  entries: RecoveryCheckpointEntry[],
  side: 'before' | 'after',
): RecoveryCheckpointEntry[] {
  // absent: deepest first; directory: shallowest first; file/symlink: after both
}
```

Move the current capture/hash/match/apply functions from `checkpoint.ts` into the module and make them operate on the v1/v2 unions.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm vitest run src/__tests__/recovery-checkpoint.test.ts -t "directory|type-change"`

Expected: PASS.

### Task 3: Artifact-store extraction and version-aware validation

**Files:**
- Create: `src/core/recovery/artifact-store.ts`
- Modify: `src/core/recovery/checkpoint.ts`
- Test: `src/__tests__/recovery-checkpoint.test.ts`
- Create: `src/__tests__/fixtures/recovery-checkpoint-v1/manifest.json`
- Create: `src/__tests__/fixtures/recovery-checkpoint-v1/state.json`
- Create: `src/__tests__/fixtures/recovery-checkpoint-v1/receipt.json`
- Create: `src/__tests__/fixtures/recovery-checkpoint-v1/blobs/9160d4be34c8695bd172a76c7c7966587ea5a4d991ad22c87b2b91af54aa9ebb`

**Interfaces:**
- Consumes: snapshot validation and state hashing from Task 2.
- Produces: `RecoveryArtifact`, `PreparedRecoveryCheckpoint`, `checkpointDir`, `checkpointsRoot`, `readRecoveryArtifact`, `writeRecoveryState`, `ensureRecoveryReceipt`, `artifactRepoRoot`, `checkpointIds`, `atomicWriteJson`, and storage-size helpers.

- [x] **Step 1: Add a failing durable v1 fixture restore test**

Copy fixture artifacts into a temporary state directory, substitute the temporary canonical repo root and current repository identity, then recompute the fixture manifest/state/receipt hashes. Do not generate the fixture shape through the v2 writer. The production change this catches is rejecting `manifest.version === 1` after v2 lands.

```ts
expect(await restoreRecoveryCheckpoint(stateDir, fixtureCheckpointId)).toMatchObject({
  changeCount: 1,
})
expect(await readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).toBe('before\n')
```

- [x] **Step 2: Add failing tamper preflight tests**

Create one test each for a missing receipt, changed manifest, changed blob, and invalid directory hash. Capture all target bytes/kinds before the call and assert they are identical afterward. The production change each catches is beginning writes before full artifact validation.

- [x] **Step 3: Run compatibility and tamper tests and verify RED**

Run: `pnpm vitest run src/__tests__/recovery-checkpoint.test.ts -t "v1 fixture|tampered|missing receipt|directory hash"`

Expected: the v1 fixture or directory validation tests FAIL for the missing union-aware reader.

- [x] **Step 4: Extract and implement version-aware artifact validation**

Accept only versions 1 and 2. Reject directory snapshots in v1. Require `resourceKind` only in v2. Validate every entry path and both sides, enforce pre-image blobs for file snapshots, validate all referenced blobs before returning, and validate receipt fields against the union manifest. Keep state and receipt `version: 1`.

- [x] **Step 5: Run compatibility and tamper tests and verify GREEN**

Run: `pnpm vitest run src/__tests__/recovery-checkpoint.test.ts -t "v1 fixture|tampered|missing receipt|directory hash"`

Expected: PASS.

### Task 4: Resource identity extraction

**Files:**
- Create: `src/core/recovery/resource-identity.ts`
- Modify: `src/core/recovery/checkpoint.ts`
- Modify: `src/core/recovery/restore.ts`
- Test: `src/__tests__/recovery-checkpoint.test.ts`

**Interfaces:**
- Produces: `currentRecoveryResourceIdentity(repoRoot, resourceKind)` and `assertRecoveryResourceIdentity(manifest)`.
- Preserves: v1 manifests are interpreted as `git_repository`.

- [x] **Step 1: Write the failing v2 resource-kind validation test**

Tamper a v2 Git manifest to claim `resourceKind: 'directory'`, update its binding hashes, and assert restore rejects the mismatched identity without writing. This catches using one identity algorithm regardless of the manifest resource kind.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run src/__tests__/recovery-checkpoint.test.ts -t "resource kind identity"`

Expected: FAIL because identity logic currently assumes Git and is embedded in `checkpoint.ts`.

- [x] **Step 3: Extract identity calculation**

For `git_repository`, hash canonical root, resolved Git metadata path, and metadata `dev`, `ino`, and `birthtimeMs`. For `directory`, hash canonical root plus the root directory's `dev`, `ino`, and `birthtimeMs`. Map v1 to the Git algorithm.

- [x] **Step 4: Run identity tests and verify GREEN**

Run: `pnpm vitest run src/__tests__/recovery-checkpoint.test.ts -t "repository recreated|resource kind identity|v1 fixture"`

Expected: PASS.

### Task 5: Reconciliation and restore transaction extraction

**Files:**
- Create: `src/core/recovery/reconcile.ts`
- Create: `src/core/recovery/restore.ts`
- Modify: `src/core/recovery/checkpoint.ts`
- Test: `src/__tests__/recovery-checkpoint.test.ts`

**Interfaces:**
- `reconcile.ts` produces `reconcileRecoveryCheckpoint` and `matchRecoverySide`.
- `restore.ts` produces `recoveryRestoreBinding` and `restoreRecoveryCheckpoint`.
- `checkpoint.ts` re-exports both modules and retains prepare/list/show/quota/discard orchestration.

- [x] **Step 1: Add failing crash-state matrix tests**

For `applying` and `restoring`, construct complete before, complete after, and mixed real workspace states. Assert exact transitions:

```ts
expect(applyingBefore).toBe('prepared')
expect(applyingAfter).toBe('applied')
expect(restoringBefore).toBe('restored')
expect(mixed).toBe('needs_manual_repair')
```

Also assert an already persisted `conflict` remains `conflict`, and a malformed artifact becomes `corrupt`; reconciliation must not infer a more optimistic state.

- [x] **Step 2: Run crash-state tests and verify RED**

Run: `pnpm vitest run src/__tests__/recovery-checkpoint.test.ts -t "crash state|reconciles"`

Expected: at least the new directory/type-change matrix case FAILS before union-aware extraction.

- [x] **Step 3: Extract reconciliation without behavior drift**

Move state matching and crash transitions into `reconcile.ts`. Use the side-aware snapshot matcher but perform no writes to repository paths. Receipt creation remains allowed only when the complete after-side matches.

- [x] **Step 4: Extract restore and use ordered transactional application**

Preflight the whole after-side first, capture rollback snapshots for every entry, verify captured snapshots again, write `restoring`, apply `before` entries in `sortRecoveryEntriesForSide(loaded.manifest.entries, 'before')` order, and verify the complete before-side. On error, apply rollback snapshots in after-side order and set `applied` only when rollback verification succeeds; otherwise set `needs_manual_repair`.

- [x] **Step 5: Run recovery tests and verify GREEN**

Run: `pnpm vitest run src/__tests__/recovery-checkpoint.test.ts`

Expected: PASS with all v1, v2, directory, tamper, conflict, and crash-state cases.

### Task 6: Facade cleanup and full verification

**Files:**
- Modify: `src/core/recovery/checkpoint.ts`
- Modify: `src/core/recovery/index.ts`
- Modify: `src/core/index.ts`
- Test: `src/__tests__/recovery-checkpoint.test.ts`

**Interfaces:**
- Preserves all existing imports from `core/recovery/checkpoint.js` and package public indexes.
- Keeps `checkpoint.ts` responsible for checkpoint preparation, listing/showing, retention/quota orchestration, and compatibility re-exports only.

- [x] **Step 1: Remove migrated private implementations from the facade**

Ensure no duplicated artifact, node, reconciliation, identity, or restore implementation remains. Keep existing constants re-exported from their owning modules so callers do not change.

- [x] **Step 2: Run formatting and static checks**

Run: `pnpm exec biome check --write src/core/recovery src/__tests__/recovery-checkpoint.test.ts docs/superpowers/plans/2026-08-10-recovery-manifest-v2.md`

Run: `pnpm typecheck`

Expected: both exit 0 with no diagnostics.

- [x] **Step 3: Run the full test suite**

Run: `pnpm test`

Expected: build succeeds and Vitest reports zero failed tests.

- [x] **Step 4: Review the final diff against PR 5 acceptance**

Run: `git diff --check`

Run: `git status --short`

Confirm the diff contains v1 fixture compatibility, v2 emission, all node kinds and type changes, full tamper preflight, deterministic crash reconciliation, and no selector enablement for `file_checkpoint`.
