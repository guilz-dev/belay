import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import type { BelayConfigV4 } from '../config.js'
import { configuredControlPlaneDir, defaultControlPlaneDir } from '../config.js'
import { canonicalPath, pathWithinRoot } from '../path-utils.js'
import { trustRecordFileName } from './paths.js'
import { parseStrictJson } from './strict-json.js'
import type { EffectManifestTrustRecordV1 } from './types.js'

export const MAX_EFFECT_MANIFEST_TRUST_BYTES = 256 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9._-]+$/

export function effectManifestTrustDir(
  config: BelayConfigV4,
  _repoLocalStateDir: string,
  repoRoot?: string,
): string {
  const configured = canonicalPath(configuredControlPlaneDir(config))
  const controlPlaneDir =
    repoRoot && pathWithinRoot(repoRoot, configured)
      ? canonicalPath(defaultControlPlaneDir())
      : configured
  return path.join(controlPlaneDir, 'effect-manifest-trust')
}

export function effectManifestTrustRecordPath(
  config: BelayConfigV4,
  repoLocalStateDir: string,
  repoRoot: string,
  canonicalExecutablePath: string,
): string {
  return path.join(
    effectManifestTrustDir(config, repoLocalStateDir, repoRoot),
    trustRecordFileName(repoRoot, canonicalExecutablePath),
  )
}

export async function loadEffectManifestTrustRecord(
  filePath: string,
): Promise<EffectManifestTrustRecordV1 | null> {
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const metadata = await stat(filePath)
    if (!metadata.isFile() || metadata.size > MAX_EFFECT_MANIFEST_TRUST_BYTES) {
      return null
    }
    const bytes = await readFile(filePath)
    if (bytes.byteLength > MAX_EFFECT_MANIFEST_TRUST_BYTES) {
      return null
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return parseEffectManifestTrustRecord(text)
  } catch {
    return null
  }
}

export function parseEffectManifestTrustRecord(text: string): EffectManifestTrustRecordV1 | null {
  const parsed = parseStrictJson(text)
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null
  }
  const raw = parsed.value
  if (
    !hasOnlyKeys(raw, [
      'schemaVersion',
      'repoRoot',
      'manifestPath',
      'commandIdentityFingerprint',
      'trustedRules',
    ]) ||
    raw.schemaVersion !== 1 ||
    !isAbsoluteString(raw.repoRoot) ||
    !isAbsoluteString(raw.manifestPath) ||
    typeof raw.commandIdentityFingerprint !== 'string' ||
    !SHA256.test(raw.commandIdentityFingerprint) ||
    !Array.isArray(raw.trustedRules) ||
    raw.trustedRules.length > 64
  ) {
    return null
  }
  const trustedRules: EffectManifestTrustRecordV1['trustedRules'] = []
  for (const entry of raw.trustedRules) {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ['id', 'ruleFingerprint', 'trustedAt']) ||
      typeof entry.id !== 'string' ||
      !SAFE_ID.test(entry.id) ||
      typeof entry.ruleFingerprint !== 'string' ||
      !SHA256.test(entry.ruleFingerprint) ||
      typeof entry.trustedAt !== 'string' ||
      !Number.isFinite(Date.parse(entry.trustedAt))
    ) {
      return null
    }
    trustedRules.push({
      id: entry.id,
      ruleFingerprint: entry.ruleFingerprint,
      trustedAt: entry.trustedAt,
    })
  }
  if (new Set(trustedRules.map((entry) => entry.id)).size !== trustedRules.length) {
    return null
  }
  return {
    schemaVersion: 1,
    repoRoot: raw.repoRoot,
    manifestPath: raw.manifestPath,
    commandIdentityFingerprint: raw.commandIdentityFingerprint,
    trustedRules,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(record).every((key) => allowed.has(key))
}

function isAbsoluteString(value: unknown): value is string {
  return typeof value === 'string' && value === value.normalize('NFC') && path.isAbsolute(value)
}

async function fsyncPath(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function saveEffectManifestTrustRecord(
  filePath: string,
  record: EffectManifestTrustRecordV1,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${randomUUID()}`
  const normalizedRecord: EffectManifestTrustRecordV1 = {
    ...record,
    repoRoot: canonicalPath(record.repoRoot),
    manifestPath: canonicalPath(record.manifestPath),
  }
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(normalizedRecord, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, filePath)
    await fsyncPath(path.dirname(filePath))
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}
