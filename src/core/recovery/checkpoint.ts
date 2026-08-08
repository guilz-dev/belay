import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { BelayTransactionalConfig } from '../config.js'
import { canonicalStringify, hashValue } from '../fingerprint.js'
import { canonicalPath } from '../path-utils.js'
import type { TransactionalFileChange } from '../transactional/types.js'
import type {
  RecoveryCheckpointEntryV1,
  RecoveryCheckpointManifestV1,
  RecoveryCheckpointState,
  RecoveryCheckpointStateV1,
  RecoveryCheckpointSummary,
  RecoveryFileSnapshotV1,
  RecoveryProofV1,
  RecoveryReceiptV1,
} from './types.js'

export const RECOVERY_CHECKPOINT_QUOTA = 'recovery_checkpoint_quota_exceeded'
export const RECOVERY_CHECKPOINT_CORRUPT = 'recovery_checkpoint_corrupt'
export const RECOVERY_RESTORE_CONFLICT = 'recovery_restore_conflict'
export const RECOVERY_RESTORE_REASON = 'recovery_restore'

const RECOVERY_STATES = new Set<RecoveryCheckpointState>([
  'prepared',
  'applying',
  'applied',
  'restoring',
  'restored',
  'conflict',
  'corrupt',
  'needs_manual_repair',
])
const STAGING_STALE_MS = 5 * 60_000

type CheckpointConfig = NonNullable<BelayTransactionalConfig['checkpoint']>

interface PreparedCheckpoint {
  checkpointId: string
  manifest: RecoveryCheckpointManifestV1
  manifestHash: string
  proofHash: string
}

function checkpointsRoot(stateDir: string): string {
  return path.join(stateDir, 'recovery', 'checkpoints')
}

function checkpointDir(stateDir: string, checkpointId: string): string {
  if (!/^cp_[a-f0-9]{24}$/.test(checkpointId)) {
    throw new Error('invalid_recovery_checkpoint_id')
  }
  return path.join(checkpointsRoot(stateDir), checkpointId)
}

async function fsyncPath(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fsyncPath(temporary)
  await rename(temporary, filePath)
  await fsyncPath(path.dirname(filePath))
}

function validRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    return false
  }
  const normalized = path.normalize(relativePath)
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`)
}

async function assertSafeTarget(repoRoot: string, relativePath: string): Promise<string> {
  if (!validRelativePath(relativePath)) {
    throw new Error('recovery_path_escape')
  }
  const root = canonicalPath(repoRoot)
  const target = path.resolve(root, relativePath)
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('recovery_path_escape')
  }

  let current = root
  const parentParts = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)
  for (const part of parentParts) {
    current = path.join(current, part)
    if (!existsSync(current)) {
      break
    }
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('recovery_symlink_escape')
    }
  }
  return target
}

function snapshotHash(snapshot: RecoveryFileSnapshotV1): string {
  return hashValue(canonicalStringify(snapshot))
}

async function currentRepoIdentity(repoRoot: string): Promise<string> {
  const resolvedRoot = await realpath(repoRoot)
  const dotGit = path.join(resolvedRoot, '.git')
  const gitInfo = await lstat(dotGit)
  let gitMetadataPath = dotGit
  if (gitInfo.isFile()) {
    const marker = (await readFile(dotGit, 'utf8')).trim()
    if (!marker.startsWith('gitdir:')) throw new Error('recovery_repo_identity_unavailable')
    gitMetadataPath = path.resolve(resolvedRoot, marker.slice('gitdir:'.length).trim())
  } else if (!gitInfo.isDirectory()) {
    throw new Error('recovery_repo_identity_unavailable')
  }
  const resolvedGitMetadataPath = await realpath(gitMetadataPath)
  const metadata = await lstat(resolvedGitMetadataPath)
  return hashValue(
    `${resolvedRoot}\0${resolvedGitMetadataPath}\0${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`,
  )
}

async function assertRepoIdentity(manifest: RecoveryCheckpointManifestV1): Promise<void> {
  if ((await currentRepoIdentity(manifest.repoRoot)) !== manifest.repoIdentity) {
    throw new Error('recovery_checkpoint_repo_mismatch')
  }
}

async function captureSnapshot(
  filePath: string,
  options?: { blobDir?: string },
): Promise<RecoveryFileSnapshotV1> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { kind: 'absent' }
  }
  if (info.isSymbolicLink()) {
    const symlinkTarget = await readlink(filePath)
    return {
      kind: 'symlink',
      symlinkTarget,
      hash: hashValue(`symlink:${symlinkTarget}`),
    }
  }
  if (!info.isFile()) {
    throw new Error('recovery_unsupported_file_kind')
  }
  const content = await readFile(filePath)
  const hash = createHash('sha256').update(content).digest('hex')
  let blob: string | undefined
  if (options?.blobDir) {
    await mkdir(options.blobDir, { recursive: true, mode: 0o700 })
    const blobPath = path.join(options.blobDir, hash)
    if (!existsSync(blobPath)) {
      await writeFile(blobPath, content, { mode: 0o600 })
      await fsyncPath(blobPath)
    }
    blob = `blobs/${hash}`
  }
  return { kind: 'file', mode: info.mode & 0o777, hash, ...(blob ? { blob } : {}) }
}

async function snapshotMatches(
  filePath: string,
  expected: RecoveryFileSnapshotV1,
): Promise<boolean> {
  try {
    const current = await captureSnapshot(filePath)
    return snapshotHash(withoutBlob(current)) === snapshotHash(withoutBlob(expected))
  } catch {
    return false
  }
}

function withoutBlob(snapshot: RecoveryFileSnapshotV1): RecoveryFileSnapshotV1 {
  const { blob: _blob, ...rest } = snapshot
  return rest
}

async function applySnapshot(
  target: string,
  snapshot: RecoveryFileSnapshotV1,
  artifactDir: string,
): Promise<void> {
  await rm(target, { force: true, recursive: false })
  if (snapshot.kind === 'absent') {
    return
  }
  await mkdir(path.dirname(target), { recursive: true })
  if (snapshot.kind === 'symlink') {
    if (snapshot.symlinkTarget === undefined) {
      throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
    }
    await symlink(snapshot.symlinkTarget, target)
    return
  }
  if (!snapshot.blob || !snapshot.hash) {
    throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
  }
  const blobPath = path.join(artifactDir, snapshot.blob)
  const content = await readFile(blobPath)
  if (createHash('sha256').update(content).digest('hex') !== snapshot.hash) {
    throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
  }
  await copyFile(blobPath, target)
  if (snapshot.mode !== undefined) {
    await chmod(target, snapshot.mode)
  }
}

async function writeState(
  artifactDir: string,
  state: RecoveryCheckpointState,
  manifestHash: string,
  detail?: string,
): Promise<void> {
  const value: RecoveryCheckpointStateV1 = {
    version: 1,
    state,
    updatedAt: new Date().toISOString(),
    manifestHash,
    ...(detail ? { detail } : {}),
  }
  await atomicWriteJson(path.join(artifactDir, 'state.json'), value)
}

async function directorySize(root: string): Promise<number> {
  if (!existsSync(root)) return 0
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) total += await directorySize(entryPath)
    else total += (await lstat(entryPath)).size
  }
  return total
}

async function readArtifact(
  stateDir: string,
  checkpointId: string,
): Promise<{
  artifactDir: string
  manifest: RecoveryCheckpointManifestV1
  state: RecoveryCheckpointStateV1
  manifestHash: string
  receipt?: RecoveryReceiptV1
}> {
  const artifactDir = checkpointDir(stateDir, checkpointId)
  const manifest = JSON.parse(
    await readFile(path.join(artifactDir, 'manifest.json'), 'utf8'),
  ) as RecoveryCheckpointManifestV1
  const state = JSON.parse(
    await readFile(path.join(artifactDir, 'state.json'), 'utf8'),
  ) as RecoveryCheckpointStateV1
  const manifestHash = hashValue(canonicalStringify(manifest))
  if (
    manifest.version !== 1 ||
    manifest.checkpointId !== checkpointId ||
    state.version !== 1 ||
    !RECOVERY_STATES.has(state.state) ||
    state.manifestHash !== manifestHash
  ) {
    throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
  }
  for (const entry of manifest.entries) {
    if (!validRelativePath(entry.path)) throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
    for (const [side, snapshot] of [
      ['before', entry.before],
      ['after', entry.after],
    ] as const) {
      if (!['absent', 'file', 'symlink'].includes(snapshot.kind)) {
        throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
      }
      if (snapshot.kind === 'file' && snapshot.blob) {
        if (!snapshot.hash || snapshot.blob !== `blobs/${snapshot.hash}`) {
          throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
        }
        const content = await readFile(path.join(artifactDir, snapshot.blob))
        if (createHash('sha256').update(content).digest('hex') !== snapshot.hash) {
          throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
        }
      }
      if (side === 'before' && snapshot.kind === 'file' && !snapshot.blob) {
        throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
      }
      if (
        snapshot.kind === 'symlink' &&
        (snapshot.symlinkTarget === undefined ||
          snapshot.hash !== hashValue(`symlink:${snapshot.symlinkTarget}`))
      ) {
        throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
      }
    }
  }
  const receiptPath = path.join(artifactDir, 'receipt.json')
  let receipt: RecoveryReceiptV1 | undefined
  if (
    ['applied', 'restoring', 'restored', 'conflict'].includes(state.state) ||
    existsSync(receiptPath)
  ) {
    receipt = await readAndValidateRecoveryReceipt(artifactDir, manifest, manifestHash)
  }
  return { artifactDir, manifest, state, manifestHash, ...(receipt ? { receipt } : {}) }
}

async function readAndValidateRecoveryReceipt(
  artifactDir: string,
  manifest: RecoveryCheckpointManifestV1,
  manifestHash: string,
): Promise<RecoveryReceiptV1> {
  let receipt: RecoveryReceiptV1
  try {
    receipt = JSON.parse(
      await readFile(path.join(artifactDir, 'receipt.json'), 'utf8'),
    ) as RecoveryReceiptV1
  } catch {
    throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
  }
  if (
    receipt.version !== 1 ||
    receipt.checkpointId !== manifest.checkpointId ||
    receipt.manifestHash !== manifestHash ||
    receipt.proofHash !== hashValue(canonicalStringify(manifest.proof)) ||
    receipt.postStateHash !== stateHash(manifest.entries, 'after') ||
    receipt.changeCount !== manifest.entries.length ||
    !Number.isFinite(Date.parse(receipt.appliedAt))
  ) {
    throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
  }
  return receipt
}

async function checkpointIds(stateDir: string): Promise<string[]> {
  const root = checkpointsRoot(stateDir)
  if (!existsSync(root)) return []
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^cp_[a-f0-9]{24}$/.test(entry.name))
    .map((entry) => entry.name)
}

async function artifactRepoRoot(stateDir: string, checkpointId: string): Promise<string | null> {
  const artifactDir = checkpointDir(stateDir, checkpointId)
  try {
    const manifest = JSON.parse(
      await readFile(path.join(artifactDir, 'manifest.json'), 'utf8'),
    ) as Partial<RecoveryCheckpointManifestV1>
    if (typeof manifest.repoRoot === 'string' && manifest.repoRoot) {
      return canonicalPath(manifest.repoRoot)
    }
  } catch {
    // Fall through to the immutable staging owner used for quota attribution.
  }
  try {
    const owner = JSON.parse(await readFile(path.join(artifactDir, 'owner.json'), 'utf8')) as {
      repoRoot?: unknown
    }
    return typeof owner.repoRoot === 'string' && owner.repoRoot
      ? canonicalPath(owner.repoRoot)
      : null
  } catch {
    return null
  }
}

async function checkpointIdsForRepo(stateDir: string, repoRoot: string): Promise<string[]> {
  const expected = canonicalPath(repoRoot)
  const matching: string[] = []
  for (const id of await checkpointIds(stateDir)) {
    if ((await artifactRepoRoot(stateDir, id)) === expected) matching.push(id)
  }
  return matching
}

async function cleanupOrphanedStaging(stateDir: string): Promise<void> {
  const root = checkpointsRoot(stateDir)
  if (!existsSync(root)) return
  const now = Date.now()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.tmp-cp_[a-f0-9]{24}$/.test(entry.name)) continue
    const stagingPath = path.join(root, entry.name)
    let stale = false
    try {
      const owner = JSON.parse(await readFile(path.join(stagingPath, 'owner.json'), 'utf8')) as {
        pid?: unknown
        createdAt?: unknown
      }
      const pid = typeof owner.pid === 'number' ? owner.pid : Number.NaN
      const createdAt = typeof owner.createdAt === 'string' ? Date.parse(owner.createdAt) : NaN
      let alive = false
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
          alive = true
        } catch {
          alive = false
        }
      }
      stale = !alive || !Number.isFinite(createdAt)
    } catch {
      const info = await lstat(stagingPath)
      stale = now - info.mtimeMs >= STAGING_STALE_MS
    }
    if (stale) await rm(stagingPath, { recursive: true, force: true })
  }
}

async function garbageCollect(
  stateDir: string,
  config: CheckpointConfig,
  repoRoot: string,
): Promise<void> {
  const artifacts: Array<{
    id: string
    state: RecoveryCheckpointState
    updatedAt: number
  }> = []
  for (const id of await checkpointIdsForRepo(stateDir, repoRoot)) {
    try {
      const loaded = await readArtifact(stateDir, id)
      artifacts.push({
        id,
        state: loaded.state.state,
        updatedAt: Date.parse(loaded.state.updatedAt),
      })
    } catch {
      // Corrupt checkpoints are retained for inspection.
    }
  }

  const now = Date.now()
  const removable = artifacts
    .filter((entry) => entry.state === 'applied' || entry.state === 'restored')
    .sort((left, right) => left.updatedAt - right.updatedAt)
  for (const entry of removable) {
    const retentionHours =
      entry.state === 'restored' ? config.restoredRetentionHours : config.appliedRetentionHours
    const expired = now - entry.updatedAt >= retentionHours * 60 * 60 * 1000
    if (!expired) continue
    await rm(checkpointDir(stateDir, entry.id), { recursive: true, force: true })
  }
}

export async function prepareRecoveryCheckpoint(params: {
  stateDir: string
  repoRoot: string
  worktreePath: string
  commandFingerprint: string
  changes: TransactionalFileChange[]
  protectedRoots?: string[]
  config: CheckpointConfig
}): Promise<PreparedCheckpoint> {
  await mkdir(checkpointsRoot(params.stateDir), { recursive: true, mode: 0o700 })
  await cleanupOrphanedStaging(params.stateDir)
  await garbageCollect(params.stateDir, params.config, params.repoRoot)
  const existing = await checkpointIdsForRepo(params.stateDir, params.repoRoot)
  if (existing.length >= params.config.maxCheckpoints) {
    throw new Error(RECOVERY_CHECKPOINT_QUOTA)
  }

  const checkpointId = `cp_${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const temporary = path.join(checkpointsRoot(params.stateDir), `.tmp-${checkpointId}`)
  const finalDir = checkpointDir(params.stateDir, checkpointId)
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  await atomicWriteJson(path.join(temporary, 'owner.json'), {
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    repoRoot: canonicalPath(params.repoRoot),
  })
  await mkdir(path.join(temporary, 'blobs'), { recursive: true, mode: 0o700 })

  try {
    const entries: RecoveryCheckpointEntryV1[] = []
    const protectedRoots = (params.protectedRoots ?? []).map(canonicalPath)
    for (const change of [...params.changes].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    )) {
      const target = await assertSafeTarget(params.repoRoot, change.relativePath)
      if (
        protectedRoots.some((root) => {
          const relative = path.relative(root, target)
          return (
            relative === '' ||
            (relative !== '..' &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          )
        })
      ) {
        throw new Error('recovery_protected_path')
      }
      const source = await assertSafeTarget(params.worktreePath, change.relativePath)
      entries.push({
        path: change.relativePath,
        before: await captureSnapshot(target, { blobDir: path.join(temporary, 'blobs') }),
        after: withoutBlob(await captureSnapshot(source)),
      })
    }

    const createdAt = new Date().toISOString()
    const proof: RecoveryProofV1 = {
      version: 1,
      backend: 'git_worktree',
      inputFingerprint: params.commandFingerprint,
      resourceScope: canonicalPath(params.repoRoot),
      baseStateHash: hashValue(canonicalStringify(entries.map((entry) => entry.before))),
      effectClosure: 'repo_local_fs_observed',
      issuedAt: createdAt,
      expiresAt: new Date(
        Date.now() + params.config.appliedRetentionHours * 60 * 60 * 1000,
      ).toISOString(),
      probeSignals: ['clean_git_worktree', 'observed_repo_local_diff'],
    }
    const manifest: RecoveryCheckpointManifestV1 = {
      version: 1,
      checkpointId,
      backend: 'git_worktree',
      repoRoot: canonicalPath(params.repoRoot),
      repoIdentity: await currentRepoIdentity(params.repoRoot),
      commandFingerprint: params.commandFingerprint,
      createdAt,
      expiresAt: proof.expiresAt,
      proof,
      entries,
    }
    const manifestHash = hashValue(canonicalStringify(manifest))
    await atomicWriteJson(path.join(temporary, 'manifest.json'), manifest)
    await writeState(temporary, 'prepared', manifestHash)
    await fsyncPath(temporary)

    const projectedBytes = await recoveryCheckpointStorageBytes(params.stateDir, params.repoRoot)
    if (projectedBytes > params.config.maxBytes) {
      throw new Error(RECOVERY_CHECKPOINT_QUOTA)
    }
    await rename(temporary, finalDir)
    await fsyncPath(checkpointsRoot(params.stateDir))
    return {
      checkpointId,
      manifest,
      manifestHash,
      proofHash: hashValue(canonicalStringify(proof)),
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

export async function markRecoveryCheckpointApplying(
  stateDir: string,
  checkpoint: PreparedCheckpoint,
): Promise<void> {
  await writeState(
    checkpointDir(stateDir, checkpoint.checkpointId),
    'applying',
    checkpoint.manifestHash,
  )
}

function stateHash(entries: RecoveryCheckpointEntryV1[], side: 'before' | 'after'): string {
  return hashValue(
    canonicalStringify(entries.map((entry) => ({ path: entry.path, state: entry[side] }))),
  )
}

async function ensureRecoveryReceipt(
  artifactDir: string,
  manifest: RecoveryCheckpointManifestV1,
  manifestHash: string,
): Promise<RecoveryReceiptV1> {
  const receiptPath = path.join(artifactDir, 'receipt.json')
  if (existsSync(receiptPath)) {
    return readAndValidateRecoveryReceipt(artifactDir, manifest, manifestHash)
  }
  const receipt: RecoveryReceiptV1 = {
    version: 1,
    checkpointId: manifest.checkpointId,
    manifestHash,
    proofHash: hashValue(canonicalStringify(manifest.proof)),
    postStateHash: stateHash(manifest.entries, 'after'),
    appliedAt: new Date().toISOString(),
    changeCount: manifest.entries.length,
  }
  await atomicWriteJson(receiptPath, receipt)
  return receipt
}

export async function markRecoveryCheckpointApplied(
  stateDir: string,
  checkpoint: PreparedCheckpoint,
): Promise<RecoveryReceiptV1> {
  const artifactDir = checkpointDir(stateDir, checkpoint.checkpointId)
  const receipt = await ensureRecoveryReceipt(
    artifactDir,
    checkpoint.manifest,
    checkpoint.manifestHash,
  )
  await writeState(artifactDir, 'applied', checkpoint.manifestHash)
  return receipt
}

async function matchSide(
  repoRoot: string,
  entries: RecoveryCheckpointEntryV1[],
  side: 'before' | 'after',
): Promise<boolean> {
  for (const entry of entries) {
    const target = await assertSafeTarget(repoRoot, entry.path)
    if (!(await snapshotMatches(target, withoutBlob(entry[side])))) return false
  }
  return true
}

export async function reconcileRecoveryCheckpoint(
  stateDir: string,
  checkpointId: string,
): Promise<RecoveryCheckpointState> {
  let loaded: Awaited<ReturnType<typeof readArtifact>>
  try {
    loaded = await readArtifact(stateDir, checkpointId)
  } catch {
    const artifactDir = checkpointDir(stateDir, checkpointId)
    if (existsSync(artifactDir)) {
      const manifestPath = path.join(artifactDir, 'manifest.json')
      const hash = existsSync(manifestPath)
        ? hashValue(await readFile(manifestPath, 'utf8'))
        : 'unavailable'
      await writeState(artifactDir, 'corrupt', hash, RECOVERY_CHECKPOINT_CORRUPT)
    }
    return 'corrupt'
  }

  if (!['prepared', 'applying', 'restoring'].includes(loaded.state.state)) {
    return loaded.state.state
  }
  const before = await matchSide(loaded.manifest.repoRoot, loaded.manifest.entries, 'before')
  const after = await matchSide(loaded.manifest.repoRoot, loaded.manifest.entries, 'after')
  if (before) {
    const state = loaded.state.state === 'restoring' ? 'restored' : 'prepared'
    await writeState(loaded.artifactDir, state, loaded.manifestHash)
    return state
  }
  if (after) {
    await ensureRecoveryReceipt(loaded.artifactDir, loaded.manifest, loaded.manifestHash)
    await writeState(loaded.artifactDir, 'applied', loaded.manifestHash)
    return 'applied'
  }
  await writeState(
    loaded.artifactDir,
    'needs_manual_repair',
    loaded.manifestHash,
    'mixed checkpoint state after interrupted operation',
  )
  return 'needs_manual_repair'
}

export async function discardPreparedRecoveryCheckpoint(
  stateDir: string,
  checkpointId: string,
): Promise<boolean> {
  const state = await reconcileRecoveryCheckpoint(stateDir, checkpointId)
  if (state !== 'prepared') return false
  const loaded = await readArtifact(stateDir, checkpointId)
  if (!(await matchSide(loaded.manifest.repoRoot, loaded.manifest.entries, 'before'))) return false
  await rm(loaded.artifactDir, { recursive: true, force: true })
  return true
}

export async function listRecoveryCheckpoints(
  stateDir: string,
  repoRoot?: string,
): Promise<RecoveryCheckpointSummary[]> {
  await cleanupOrphanedStaging(stateDir)
  const summaries: RecoveryCheckpointSummary[] = []
  for (const id of await checkpointIds(stateDir)) {
    if (repoRoot) {
      let artifactRepoRoot: string | undefined
      try {
        artifactRepoRoot = (await readArtifact(stateDir, id)).manifest.repoRoot
      } catch {
        try {
          const raw = JSON.parse(
            await readFile(path.join(checkpointDir(stateDir, id), 'manifest.json'), 'utf8'),
          ) as Partial<RecoveryCheckpointManifestV1>
          artifactRepoRoot =
            typeof raw.repoRoot === 'string' && raw.repoRoot ? raw.repoRoot : undefined
        } catch {
          artifactRepoRoot = undefined
        }
      }
      if (!artifactRepoRoot || canonicalPath(artifactRepoRoot) !== canonicalPath(repoRoot)) continue
    }
    const state = await reconcileRecoveryCheckpoint(stateDir, id)
    try {
      const loaded = await readArtifact(stateDir, id)
      if (repoRoot && canonicalPath(loaded.manifest.repoRoot) !== canonicalPath(repoRoot)) continue
      summaries.push({
        checkpointId: id,
        state,
        ...(loaded.state.detail ? { stateDetail: loaded.state.detail } : {}),
        backend: loaded.manifest.backend,
        repoRoot: loaded.manifest.repoRoot,
        commandFingerprint: loaded.manifest.commandFingerprint,
        createdAt: loaded.manifest.createdAt,
        expiresAt: loaded.manifest.expiresAt,
        changeCount: loaded.manifest.entries.length,
        manifestHash: loaded.manifestHash,
        ...(loaded.receipt
          ? {
              receiptHash: hashValue(canonicalStringify(loaded.receipt)),
              proofHash: loaded.receipt.proofHash,
              postStateHash: loaded.receipt.postStateHash,
            }
          : {}),
      })
    } catch {
      // Expose corrupt artifacts for operator repair without trusting them for restore.
      try {
        const manifest = JSON.parse(
          await readFile(path.join(checkpointDir(stateDir, id), 'manifest.json'), 'utf8'),
        ) as RecoveryCheckpointManifestV1
        if (manifest.checkpointId !== id || manifest.version !== 1) continue
        if (repoRoot && canonicalPath(manifest.repoRoot) !== canonicalPath(repoRoot)) continue
        summaries.push({
          checkpointId: id,
          state: 'corrupt',
          backend: manifest.backend,
          repoRoot: manifest.repoRoot,
          commandFingerprint: manifest.commandFingerprint,
          createdAt: manifest.createdAt,
          expiresAt: manifest.expiresAt,
          changeCount: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
          manifestHash: hashValue(canonicalStringify(manifest)),
        })
      } catch {
        // No trustworthy repository identity is available for this artifact.
      }
    }
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function recoveryCheckpointStorageBytes(
  stateDir: string,
  repoRoot?: string,
): Promise<number> {
  const root = checkpointsRoot(stateDir)
  if (!repoRoot) return directorySize(root)
  if (!existsSync(root)) return 0
  const expected = canonicalPath(repoRoot)
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const entryPath = path.join(root, entry.name)
    if (/^cp_[a-f0-9]{24}$/.test(entry.name)) {
      if ((await artifactRepoRoot(stateDir, entry.name)) === expected) {
        total += await directorySize(entryPath)
      }
      continue
    }
    if (/^\.tmp-cp_[a-f0-9]{24}$/.test(entry.name)) {
      try {
        const owner = JSON.parse(await readFile(path.join(entryPath, 'owner.json'), 'utf8')) as {
          repoRoot?: unknown
        }
        if (typeof owner.repoRoot === 'string' && canonicalPath(owner.repoRoot) === expected) {
          total += await directorySize(entryPath)
        }
      } catch {
        // Unattributable staging data is excluded from per-repository accounting and
        // removed by the stale staging reconciler once it is safe to do so.
      }
    }
  }
  return total
}

export async function showRecoveryCheckpoint(
  stateDir: string,
  checkpointId: string,
  expectedRepoRoot?: string,
) {
  if (
    expectedRepoRoot &&
    (await artifactRepoRoot(stateDir, checkpointId)) !== canonicalPath(expectedRepoRoot)
  ) {
    throw new Error('recovery_checkpoint_repo_mismatch')
  }
  await reconcileRecoveryCheckpoint(stateDir, checkpointId)
  return readArtifact(stateDir, checkpointId)
}

export async function recoveryRestoreBinding(
  stateDir: string,
  checkpointId: string,
  expectedRepoRoot?: string,
): Promise<{
  fingerprint: string
  manifestHash: string
  postStateHash: string
  paths: string[]
  repoRoot: string
}> {
  if (
    expectedRepoRoot &&
    (await artifactRepoRoot(stateDir, checkpointId)) !== canonicalPath(expectedRepoRoot)
  ) {
    throw new Error('recovery_checkpoint_repo_mismatch')
  }
  const loaded = await readArtifact(stateDir, checkpointId)
  await assertRepoIdentity(loaded.manifest)
  if (Date.parse(loaded.manifest.expiresAt) <= Date.now()) {
    throw new Error('recovery_checkpoint_expired')
  }
  if (!['applied', 'conflict'].includes(loaded.state.state)) {
    throw new Error(`recovery_checkpoint_not_applied:${loaded.state.state}`)
  }
  if (!(await matchSide(loaded.manifest.repoRoot, loaded.manifest.entries, 'after'))) {
    await writeState(loaded.artifactDir, 'conflict', loaded.manifestHash, RECOVERY_RESTORE_CONFLICT)
    throw new Error(RECOVERY_RESTORE_CONFLICT)
  }
  const paths = loaded.manifest.entries.map((entry) => entry.path).sort()
  const postStateHash = stateHash(loaded.manifest.entries, 'after')
  return {
    fingerprint: hashValue(
      canonicalStringify({
        action: 'recovery.restore',
        repoRoot: loaded.manifest.repoRoot,
        checkpointId,
        manifestHash: loaded.manifestHash,
        postStateHash,
        paths,
      }),
    ),
    manifestHash: loaded.manifestHash,
    postStateHash,
    paths,
    repoRoot: loaded.manifest.repoRoot,
  }
}

export async function restoreRecoveryCheckpoint(
  stateDir: string,
  checkpointId: string,
  expectedRepoRoot?: string,
): Promise<{ manifestHash: string; changeCount: number }> {
  if (
    expectedRepoRoot &&
    (await artifactRepoRoot(stateDir, checkpointId)) !== canonicalPath(expectedRepoRoot)
  ) {
    throw new Error('recovery_checkpoint_repo_mismatch')
  }
  const loaded = await readArtifact(stateDir, checkpointId)
  await assertRepoIdentity(loaded.manifest)
  if (Date.parse(loaded.manifest.expiresAt) <= Date.now()) {
    throw new Error('recovery_checkpoint_expired')
  }
  if (!['applied', 'conflict'].includes(loaded.state.state)) {
    throw new Error(`recovery_checkpoint_not_applied:${loaded.state.state}`)
  }
  if (!(await matchSide(loaded.manifest.repoRoot, loaded.manifest.entries, 'after'))) {
    await writeState(loaded.artifactDir, 'conflict', loaded.manifestHash, RECOVERY_RESTORE_CONFLICT)
    throw new Error(RECOVERY_RESTORE_CONFLICT)
  }

  const rollbackDir = await mkdtemp(path.join(os.tmpdir(), 'belay-recovery-rollback-'))
  const rollback: Array<{ target: string; snapshot: RecoveryFileSnapshotV1 }> = []
  try {
    for (const entry of loaded.manifest.entries) {
      const target = await assertSafeTarget(loaded.manifest.repoRoot, entry.path)
      rollback.push({
        target,
        snapshot: await captureSnapshot(target, { blobDir: path.join(rollbackDir, 'blobs') }),
      })
    }
    const capturedPostStateMatches = rollback.every((item, index) => {
      const expected = loaded.manifest.entries[index]?.after
      return (
        expected !== undefined &&
        snapshotHash(withoutBlob(item.snapshot)) === snapshotHash(withoutBlob(expected))
      )
    })
    if (!capturedPostStateMatches) {
      await writeState(
        loaded.artifactDir,
        'conflict',
        loaded.manifestHash,
        RECOVERY_RESTORE_CONFLICT,
      )
      throw new Error(RECOVERY_RESTORE_CONFLICT)
    }
    await writeState(loaded.artifactDir, 'restoring', loaded.manifestHash)
    for (const entry of loaded.manifest.entries) {
      const target = await assertSafeTarget(loaded.manifest.repoRoot, entry.path)
      await applySnapshot(target, entry.before, loaded.artifactDir)
    }
    if (!(await matchSide(loaded.manifest.repoRoot, loaded.manifest.entries, 'before'))) {
      throw new Error('recovery_restore_verification_failed')
    }
    await writeState(loaded.artifactDir, 'restored', loaded.manifestHash)
    return { manifestHash: loaded.manifestHash, changeCount: loaded.manifest.entries.length }
  } catch (error) {
    let rollbackFailed = false
    for (const item of rollback) {
      try {
        await applySnapshot(item.target, item.snapshot, rollbackDir)
      } catch {
        rollbackFailed = true
      }
    }
    const rollbackVerified =
      !rollbackFailed &&
      (await matchSide(loaded.manifest.repoRoot, loaded.manifest.entries, 'after'))
    const conflictBeforeWrites =
      error instanceof Error && error.message === RECOVERY_RESTORE_CONFLICT
    await writeState(
      loaded.artifactDir,
      conflictBeforeWrites ? 'conflict' : rollbackVerified ? 'applied' : 'needs_manual_repair',
      loaded.manifestHash,
      error instanceof Error ? error.message : 'recovery_restore_failed',
    )
    throw error
  } finally {
    await rm(rollbackDir, { recursive: true, force: true }).catch(() => {})
  }
}
