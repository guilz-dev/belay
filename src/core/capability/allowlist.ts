import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { BelayConfigV3 } from '../config.js'
import { belayStateDir } from '../config.js'
import { canonicalPath, pathWithinRoot } from '../path-utils.js'
import type { FsScopeAllowlistEntry, FsScopeAllowlistFile } from './types.js'

export function fsScopeAllowlistPath(config: BelayConfigV3, repoLocalStateDir: string): string {
  return path.join(belayStateDir(config, repoLocalStateDir), 'fs-scope-allowlist.json')
}

export async function loadFsScopeAllowlist(filePath: string): Promise<FsScopeAllowlistFile> {
  if (!existsSync(filePath)) {
    return { version: 1, paths: [] }
  }
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as FsScopeAllowlistFile
  return {
    version: 1,
    paths: Array.isArray(raw.paths) ? raw.paths : [],
  }
}

export function loadFsScopeAllowlistSync(filePath: string): FsScopeAllowlistFile {
  if (!existsSync(filePath)) {
    return { version: 1, paths: [] }
  }
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as FsScopeAllowlistFile
  return {
    version: 1,
    paths: Array.isArray(raw.paths) ? raw.paths : [],
  }
}

export async function saveFsScopeAllowlist(
  filePath: string,
  state: FsScopeAllowlistFile,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export function normalizeAllowlistPath(targetPath: string): string {
  return canonicalPath(targetPath)
}

export function isPathAllowlisted(absolutePath: string, allowlist: FsScopeAllowlistFile): boolean {
  const resolved = normalizeAllowlistPath(absolutePath)
  return allowlist.paths.some((entry) => {
    const scope = normalizeAllowlistPath(entry.path)
    return resolved === scope || pathWithinRoot(scope, resolved)
  })
}

export function allPathsAllowlisted(
  absolutePaths: string[],
  allowlist: FsScopeAllowlistFile,
): boolean {
  return (
    absolutePaths.length > 0 && absolutePaths.every((entry) => isPathAllowlisted(entry, allowlist))
  )
}

export function addPathToAllowlist(
  allowlist: FsScopeAllowlistFile,
  entry: FsScopeAllowlistEntry,
): FsScopeAllowlistFile {
  const normalized = normalizeAllowlistPath(entry.path)
  const filtered = allowlist.paths.filter(
    (existing) => normalizeAllowlistPath(existing.path) !== normalized,
  )
  return {
    version: 1,
    paths: [...filtered, { ...entry, path: normalized }],
  }
}
