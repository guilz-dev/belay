import { existsSync, readFileSync, statSync } from 'node:fs'

import { parseEffectManifestV1 } from './codec.js'
import { manifestFilePath } from './paths.js'
import type { EffectManifestV1 } from './types.js'

/** Bounded gate read budget aligned with manifest schema limits. */
export const MAX_EFFECT_MANIFEST_BYTES = 256 * 1024

export type LoadEffectManifestResult =
  | { ok: true; manifest: EffectManifestV1 }
  | { ok: false; reason: string }

export function loadEffectManifestSync(
  repoRoot: string,
  basename: string,
): LoadEffectManifestResult {
  const filePath = manifestFilePath(repoRoot, basename)
  if (!existsSync(filePath)) {
    return { ok: false, reason: 'no_manifest' }
  }
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) {
      return { ok: false, reason: 'not_regular_file' }
    }
    if (stat.size > MAX_EFFECT_MANIFEST_BYTES) {
      return { ok: false, reason: 'oversized' }
    }
    const raw = readFileSync(filePath, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_EFFECT_MANIFEST_BYTES) {
      return { ok: false, reason: 'oversized' }
    }
    const manifest = parseEffectManifestV1(JSON.parse(raw) as unknown)
    if (!manifest) {
      return { ok: false, reason: 'schema_invalid' }
    }
    return { ok: true, manifest }
  } catch {
    return { ok: false, reason: 'read_failed' }
  }
}

export function readEffectManifestFromPath(filePath: string): EffectManifestV1 | null {
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_EFFECT_MANIFEST_BYTES) {
      return null
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    return parseEffectManifestV1(raw)
  } catch {
    return null
  }
}
