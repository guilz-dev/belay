import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { BelayConfigV4 } from '../config.js'
import { belayStateDir } from '../config.js'
import { trustRecordFileName } from './paths.js'
import type { EffectManifestTrustRecordV1 } from './types.js'

export function effectManifestTrustDir(config: BelayConfigV4, repoLocalStateDir: string): string {
  return path.join(belayStateDir(config, repoLocalStateDir), 'effect-manifest-trust')
}

export function effectManifestTrustRecordPath(
  config: BelayConfigV4,
  repoLocalStateDir: string,
  repoRoot: string,
  canonicalExecutablePath: string,
): string {
  return path.join(
    effectManifestTrustDir(config, repoLocalStateDir),
    trustRecordFileName(repoRoot, canonicalExecutablePath),
  )
}

export async function loadEffectManifestTrustRecord(
  filePath: string,
): Promise<EffectManifestTrustRecordV1 | null> {
  if (!existsSync(filePath)) {
    return null
  }
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as EffectManifestTrustRecordV1
  if (raw.schemaVersion !== 1 || typeof raw.repoRoot !== 'string') {
    return null
  }
  if (!Array.isArray(raw.trustedRules)) {
    return null
  }
  return raw
}

export async function saveEffectManifestTrustRecord(
  filePath: string,
  record: EffectManifestTrustRecordV1,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
}
