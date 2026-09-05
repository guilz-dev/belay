import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import type { AdapterName } from '../types.js'
import { defaultControlPlaneDir } from './config.js'
import { canonicalStringify, hashValue } from './fingerprint.js'
import { canonicalPath } from './path-utils.js'

export interface RepoConfigTrustRecordV1 {
  schemaVersion: 1
  repoRoot: string
  adapter: 'cursor' | 'claude' | 'codex'
  repoConfigFingerprint: string
  trustedAt: string
}

export type RepoConfigTrustStatus =
  | { trusted: true; recordPath: string; fingerprint: string }
  | {
      trusted: false
      recordPath: string
      reason: 'missing' | 'malformed' | 'identity_mismatch' | 'fingerprint_mismatch'
    }

const TRUST_MESSAGE = 'Repository config is not trusted. Review it, then run `belay config trust`.'

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyExpectedKeys(value: Record<string, unknown>): boolean {
  const expected = new Set([
    'schemaVersion',
    'repoRoot',
    'adapter',
    'repoConfigFingerprint',
    'trustedAt',
  ])
  const keys = Object.keys(value)
  if (keys.length !== expected.size) {
    return false
  }
  return keys.every((key) => expected.has(key))
}

function isAdapterName(value: unknown): value is AdapterName {
  return value === 'cursor' || value === 'claude' || value === 'codex'
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}

function parseStrictTrustRecord(value: unknown): RepoConfigTrustRecordV1 | null {
  if (!isObjectRecord(value) || !hasOnlyExpectedKeys(value)) {
    return null
  }
  if (value.schemaVersion !== 1) {
    return null
  }
  if (typeof value.repoRoot !== 'string' || value.repoRoot.trim().length === 0) {
    return null
  }
  if (!isAdapterName(value.adapter)) {
    return null
  }
  if (
    typeof value.repoConfigFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.repoConfigFingerprint)
  ) {
    return null
  }
  if (typeof value.trustedAt !== 'string' || !isIsoTimestamp(value.trustedAt)) {
    return null
  }
  return {
    schemaVersion: 1,
    repoRoot: value.repoRoot,
    adapter: value.adapter,
    repoConfigFingerprint: value.repoConfigFingerprint,
    trustedAt: value.trustedAt,
  }
}

export function repoConfigFingerprint(rawConfig: unknown): string {
  return hashValue(canonicalStringify(rawConfig))
}

export function repoConfigTrustPath(repoRoot: string, adapter: AdapterName): string {
  const canonicalRepoRoot = canonicalPath(repoRoot)
  const identity = hashValue(`${canonicalRepoRoot}\u0000${adapter}`)
  return path.join(defaultControlPlaneDir(), 'config-trust', `${identity}.json`)
}

async function writeTrustRecordAtomically(
  recordPath: string,
  record: RepoConfigTrustRecordV1,
): Promise<void> {
  const directory = path.dirname(recordPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700).catch(() => undefined)
  const tempPath = path.join(
    directory,
    `.${path.basename(recordPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tempPath, recordPath)
    await chmod(recordPath, 0o600)

    const directoryHandle = await open(directory, 'r')
    try {
      await directoryHandle.sync().catch(() => undefined)
    } finally {
      await directoryHandle.close()
    }
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined)
    }
    await unlink(tempPath).catch(() => undefined)
  }
}

export async function inspectRepoConfigTrust(
  repoRoot: string,
  adapter: AdapterName,
  rawConfig: unknown,
): Promise<RepoConfigTrustStatus> {
  const canonicalRepoRoot = canonicalPath(repoRoot)
  const recordPath = repoConfigTrustPath(repoRoot, adapter)
  if (!existsSync(recordPath)) {
    return { trusted: false, recordPath, reason: 'missing' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(recordPath, 'utf8'))
  } catch {
    return { trusted: false, recordPath, reason: 'malformed' }
  }

  const record = parseStrictTrustRecord(parsed)
  if (!record) {
    return { trusted: false, recordPath, reason: 'malformed' }
  }
  if (record.adapter !== adapter || canonicalPath(record.repoRoot) !== canonicalRepoRoot) {
    return { trusted: false, recordPath, reason: 'identity_mismatch' }
  }

  const fingerprint = repoConfigFingerprint(rawConfig)
  if (record.repoConfigFingerprint !== fingerprint) {
    return { trusted: false, recordPath, reason: 'fingerprint_mismatch' }
  }

  return { trusted: true, recordPath, fingerprint }
}

export async function trustRepoConfig(
  repoRoot: string,
  adapter: AdapterName,
  rawConfig: unknown,
): Promise<RepoConfigTrustRecordV1> {
  const recordPath = repoConfigTrustPath(repoRoot, adapter)
  const record: RepoConfigTrustRecordV1 = {
    schemaVersion: 1,
    repoRoot: canonicalPath(repoRoot),
    adapter,
    repoConfigFingerprint: repoConfigFingerprint(rawConfig),
    trustedAt: new Date().toISOString(),
  }
  await writeTrustRecordAtomically(recordPath, record)
  return record
}

export class RepoConfigTrustError extends Error {
  readonly status: Exclude<RepoConfigTrustStatus, { trusted: true }>

  constructor(status: Exclude<RepoConfigTrustStatus, { trusted: true }>) {
    super(TRUST_MESSAGE)
    this.name = 'RepoConfigTrustError'
    this.status = status
  }
}

export function isRepoConfigTrustError(error: unknown): error is RepoConfigTrustError {
  return error instanceof RepoConfigTrustError
}

export async function assertRepoConfigTrusted(
  repoRoot: string,
  adapter: AdapterName,
  rawConfig: unknown,
): Promise<void> {
  const status = await inspectRepoConfigTrust(repoRoot, adapter, rawConfig)
  if (status.trusted) {
    return
  }
  throw new RepoConfigTrustError(status)
}
