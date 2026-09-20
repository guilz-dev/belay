import { createHash } from 'node:crypto'
import path from 'node:path'

import { canonicalPath } from '../path-utils.js'

const BASENAME_PATTERN = /^[A-Za-z0-9._-]+$/

export function normalizeManifestBasename(head: string): string | null {
  const base = path.basename(head)
  if (!base || base === '.' || base === '..' || base.length > 255 || !BASENAME_PATTERN.test(base)) {
    return null
  }
  return base
}

export function manifestFilePath(repoRoot: string, basename: string): string {
  return path.join(repoRoot, '.belay', 'manifests', `${basename}.json`)
}

export function trustRecordFileName(repoRoot: string, canonicalExecutablePath: string): string {
  const digest = createHash('sha256')
    .update(`${canonicalPath(repoRoot)}\0${canonicalPath(canonicalExecutablePath)}`, 'utf8')
    .digest('hex')
  return `${digest}.json`
}
