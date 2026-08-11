import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { canonicalStringify, hashValue } from '../fingerprint.js'
import { canonicalPath } from '../path-utils.js'
import {
  recoveryStateHash,
  validateRecoverySnapshot,
  validRecoveryRelativePath,
} from './snapshot-node.js'
import type {
  RecoveryCheckpointManifest,
  RecoveryCheckpointState,
  RecoveryCheckpointStateV1,
  RecoveryReceiptV1,
} from './types.js'

export const RECOVERY_CHECKPOINT_CORRUPT = 'recovery_checkpoint_corrupt'

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

export interface PreparedRecoveryCheckpoint {
  checkpointId: string
  manifest: RecoveryCheckpointManifest
  manifestHash: string
  proofHash: string
}

export interface RecoveryArtifact {
  artifactDir: string
  manifest: RecoveryCheckpointManifest
  state: RecoveryCheckpointStateV1
  manifestHash: string
  receipt?: RecoveryReceiptV1
}

export function checkpointsRoot(stateDir: string): string {
  return path.join(stateDir, 'recovery', 'checkpoints')
}

export function checkpointDir(stateDir: string, checkpointId: string): string {
  if (!/^cp_[a-f0-9]{24}$/.test(checkpointId)) {
    throw new Error('invalid_recovery_checkpoint_id')
  }
  return path.join(checkpointsRoot(stateDir), checkpointId)
}

export async function fsyncPath(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fsyncPath(temporary)
  await rename(temporary, filePath)
  await fsyncPath(path.dirname(filePath))
}

export async function writeRecoveryState(
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

export async function directorySize(root: string): Promise<number> {
  if (!existsSync(root)) return 0
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) total += await directorySize(entryPath)
    else total += (await lstat(entryPath)).size
  }
  return total
}

function isManifestShape(
  value: unknown,
  checkpointId: string,
): value is RecoveryCheckpointManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Record<string, unknown>
  const proof = manifest.proof as Record<string, unknown> | undefined
  const manifestKeys = [
    'version',
    'checkpointId',
    'backend',
    'repoRoot',
    'repoIdentity',
    'commandFingerprint',
    'createdAt',
    'expiresAt',
    'proof',
    'entries',
    ...(manifest.version === 2 ? ['resourceKind'] : []),
  ]
  const proofKeys = [
    'version',
    'backend',
    'inputFingerprint',
    'resourceScope',
    'baseStateHash',
    'effectClosure',
    'issuedAt',
    'expiresAt',
    'probeSignals',
  ]
  if (
    ![1, 2].includes(manifest.version as number) ||
    Object.keys(manifest).length !== manifestKeys.length ||
    !Object.keys(manifest).every((key) => manifestKeys.includes(key)) ||
    manifest.checkpointId !== checkpointId ||
    !['git_worktree', 'file_checkpoint'].includes(String(manifest.backend)) ||
    typeof manifest.repoRoot !== 'string' ||
    typeof manifest.repoIdentity !== 'string' ||
    typeof manifest.commandFingerprint !== 'string' ||
    typeof manifest.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    typeof manifest.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.expiresAt)) ||
    !Array.isArray(manifest.entries) ||
    !proof ||
    Object.keys(proof).length !== proofKeys.length ||
    !Object.keys(proof).every((key) => proofKeys.includes(key)) ||
    proof.version !== 1 ||
    proof.backend !== manifest.backend ||
    typeof proof.inputFingerprint !== 'string' ||
    proof.inputFingerprint !== manifest.commandFingerprint ||
    typeof proof.resourceScope !== 'string' ||
    proof.resourceScope !== manifest.repoRoot ||
    typeof proof.baseStateHash !== 'string' ||
    proof.effectClosure !== 'repo_local_fs_observed' ||
    typeof proof.issuedAt !== 'string' ||
    !Number.isFinite(Date.parse(proof.issuedAt)) ||
    proof.issuedAt !== manifest.createdAt ||
    typeof proof.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(proof.expiresAt)) ||
    proof.expiresAt !== manifest.expiresAt ||
    !Array.isArray(proof.probeSignals) ||
    !proof.probeSignals.every((signal) => typeof signal === 'string')
  ) {
    return false
  }
  if (manifest.version === 1) return !('resourceKind' in manifest)
  return ['git_repository', 'directory'].includes(String(manifest.resourceKind))
}

export async function readRecoveryArtifact(
  stateDir: string,
  checkpointId: string,
): Promise<RecoveryArtifact> {
  const artifactDir = checkpointDir(stateDir, checkpointId)
  let rawManifest: unknown
  let state: RecoveryCheckpointStateV1
  try {
    rawManifest = JSON.parse(await readFile(path.join(artifactDir, 'manifest.json'), 'utf8'))
    state = JSON.parse(
      await readFile(path.join(artifactDir, 'state.json'), 'utf8'),
    ) as RecoveryCheckpointStateV1
  } catch {
    throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
  }
  if (!isManifestShape(rawManifest, checkpointId)) throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
  const manifest = rawManifest
  const manifestHash = hashValue(canonicalStringify(manifest))
  const stateKeys = state && typeof state === 'object' ? Object.keys(state) : []
  const expectedStateKeys = ['version', 'state', 'updatedAt', 'manifestHash']
  if (state && typeof state === 'object' && 'detail' in state) expectedStateKeys.push('detail')
  if (
    !state ||
    typeof state !== 'object' ||
    Array.isArray(state) ||
    stateKeys.length !== expectedStateKeys.length ||
    !stateKeys.every((key) => expectedStateKeys.includes(key)) ||
    state.version !== 1 ||
    !RECOVERY_STATES.has(state.state) ||
    typeof state.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(state.updatedAt)) ||
    (state.detail !== undefined && typeof state.detail !== 'string') ||
    state.manifestHash !== manifestHash
  ) {
    throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
  }
  const entryPaths = new Set<string>()
  for (const entry of manifest.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 3 ||
      !Object.keys(entry).every((key) => ['path', 'before', 'after'].includes(key)) ||
      typeof entry.path !== 'string' ||
      !('before' in entry) ||
      !('after' in entry) ||
      !validRecoveryRelativePath(entry.path) ||
      entryPaths.has(path.normalize(entry.path))
    ) {
      throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
    }
    entryPaths.add(path.normalize(entry.path))
    for (const [side, snapshot] of [
      ['before', entry.before],
      ['after', entry.after],
    ] as const) {
      await validateRecoverySnapshot({
        snapshot,
        side,
        manifestVersion: manifest.version,
        artifactDir,
        corruptReason: RECOVERY_CHECKPOINT_CORRUPT,
      })
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
  manifest: RecoveryCheckpointManifest,
  manifestHash: string,
): Promise<RecoveryReceiptV1> {
  let rawReceipt: unknown
  try {
    rawReceipt = JSON.parse(await readFile(path.join(artifactDir, 'receipt.json'), 'utf8'))
  } catch {
    throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
  }
  if (!rawReceipt || typeof rawReceipt !== 'object' || Array.isArray(rawReceipt)) {
    throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
  }
  const receipt = rawReceipt as Record<string, unknown>
  const receiptKeys = [
    'version',
    'checkpointId',
    'manifestHash',
    'proofHash',
    'postStateHash',
    'appliedAt',
    'changeCount',
  ]
  if (
    Object.keys(receipt).length !== receiptKeys.length ||
    !Object.keys(receipt).every((key) => receiptKeys.includes(key)) ||
    receipt.version !== 1 ||
    receipt.checkpointId !== manifest.checkpointId ||
    receipt.manifestHash !== manifestHash ||
    receipt.proofHash !== hashValue(canonicalStringify(manifest.proof)) ||
    receipt.postStateHash !== recoveryStateHash(manifest.entries, 'after') ||
    receipt.changeCount !== manifest.entries.length ||
    typeof receipt.appliedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.appliedAt))
  ) {
    throw new Error(RECOVERY_CHECKPOINT_CORRUPT)
  }
  return receipt as unknown as RecoveryReceiptV1
}

export async function ensureRecoveryReceipt(
  artifactDir: string,
  manifest: RecoveryCheckpointManifest,
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
    postStateHash: recoveryStateHash(manifest.entries, 'after'),
    appliedAt: new Date().toISOString(),
    changeCount: manifest.entries.length,
  }
  await atomicWriteJson(receiptPath, receipt)
  return receipt
}

export async function checkpointIds(stateDir: string): Promise<string[]> {
  const root = checkpointsRoot(stateDir)
  if (!existsSync(root)) return []
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^cp_[a-f0-9]{24}$/.test(entry.name))
    .map((entry) => entry.name)
}

export async function artifactRepoRoot(
  stateDir: string,
  checkpointId: string,
): Promise<string | null> {
  const artifactDir = checkpointDir(stateDir, checkpointId)
  try {
    const manifest = JSON.parse(
      await readFile(path.join(artifactDir, 'manifest.json'), 'utf8'),
    ) as { repoRoot?: unknown }
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

export async function checkpointIdsForRepo(stateDir: string, repoRoot: string): Promise<string[]> {
  const expected = canonicalPath(repoRoot)
  const matching: string[] = []
  for (const id of await checkpointIds(stateDir)) {
    if ((await artifactRepoRoot(stateDir, id)) === expected) matching.push(id)
  }
  return matching
}

export async function cleanupOrphanedStaging(stateDir: string): Promise<void> {
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

export async function markRecoveryCheckpointApplying(
  stateDir: string,
  checkpoint: PreparedRecoveryCheckpoint,
): Promise<void> {
  await writeRecoveryState(
    checkpointDir(stateDir, checkpoint.checkpointId),
    'applying',
    checkpoint.manifestHash,
  )
}

export async function markRecoveryCheckpointApplied(
  stateDir: string,
  checkpoint: PreparedRecoveryCheckpoint,
): Promise<RecoveryReceiptV1> {
  const artifactDir = checkpointDir(stateDir, checkpoint.checkpointId)
  const receipt = await ensureRecoveryReceipt(
    artifactDir,
    checkpoint.manifest,
    checkpoint.manifestHash,
  )
  await writeRecoveryState(artifactDir, 'applied', checkpoint.manifestHash)
  return receipt
}
