import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { BelayConfigV3 } from '../config.js'
import { belayStateDir } from '../config.js'
import {
  canonicalPath,
  containingGitRoot,
  pathWithinRoot,
  resolveWorkspaceRootMatch,
} from '../path-utils.js'
import type { TrustedWorkspaceRootEntry, TrustedWorkspaceRootsFile } from './types.js'

export function trustedWorkspaceRootsPath(
  config: BelayConfigV3,
  repoLocalStateDir: string,
): string {
  return path.join(belayStateDir(config, repoLocalStateDir), 'trusted-workspace-roots.json')
}

export async function loadTrustedWorkspaceRoots(
  filePath: string,
): Promise<TrustedWorkspaceRootsFile> {
  if (!existsSync(filePath)) {
    return { version: 1, roots: [] }
  }
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as TrustedWorkspaceRootsFile
  return { version: 1, roots: sanitizeTrustedWorkspaceRootEntries(raw.roots) }
}

export function loadTrustedWorkspaceRootsSync(filePath: string): TrustedWorkspaceRootsFile {
  if (!existsSync(filePath)) {
    return { version: 1, roots: [] }
  }
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as TrustedWorkspaceRootsFile
  return { version: 1, roots: sanitizeTrustedWorkspaceRootEntries(raw.roots) }
}

export async function saveTrustedWorkspaceRoots(
  filePath: string,
  state: TrustedWorkspaceRootsFile,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export function normalizeTrustedWorkspaceRootPath(targetPath: string): string {
  return canonicalPath(targetPath)
}

function sanitizeTrustedWorkspaceRootEntries(input: unknown): TrustedWorkspaceRootEntry[] {
  if (!Array.isArray(input)) {
    return []
  }
  return input.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }
    const record = entry as Record<string, unknown>
    if (typeof record.path !== 'string' || !record.path.trim()) {
      return []
    }
    const approvedAt =
      typeof record.approvedAt === 'string' ? record.approvedAt : new Date(0).toISOString()
    const approvalId = typeof record.approvalId === 'string' ? record.approvalId : 'unknown'
    const source = record.source === 'approval' ? 'approval' : undefined
    return [
      {
        path: path.resolve(record.path),
        approvedAt,
        approvalId,
        ...(source ? { source } : {}),
      },
    ]
  })
}

export interface TrustedWorkspaceRootValidationParams {
  candidatePath: string
  repoRoot: string
  controlPlaneDir?: string | null
  protectedRoots?: string[]
  requireExistingDirectory?: boolean
  requireNonGit?: boolean
}

export interface TrustedWorkspaceRootValidationResult {
  ok: boolean
  normalizedPath: string
  reason?:
    | 'not_directory'
    | 'broad_root'
    | 'high_stakes'
    | 'inside_repo'
    | 'inside_git_repo'
    | 'control_plane_overlap'
    | 'protected_root_overlap'
}

const SYSTEM_HIGH_STAKES_PREFIXES = [
  '/etc',
  '/private/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/opt',
  '/System',
  '/Library',
] as const

const HOME_HIGH_STAKES_SEGMENTS = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config'] as const

function isDirectoryPath(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory()
  } catch {
    return false
  }
}

export function isBroadTrustedWorkspaceRoot(targetPath: string): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE
  const root = normalizeTrustedWorkspaceRootPath(targetPath)
  if (root === normalizeTrustedWorkspaceRootPath(path.parse(root).root)) {
    return true
  }
  if (home && normalizeTrustedWorkspaceRootPath(home) === root) {
    return true
  }
  return false
}

export function isHighStakesTrustedWorkspaceRoot(targetPath: string): boolean {
  const normalized = normalizeTrustedWorkspaceRootPath(targetPath)
  if (
    SYSTEM_HIGH_STAKES_PREFIXES.some(
      (prefix) =>
        normalized === normalizeTrustedWorkspaceRootPath(prefix) ||
        pathWithinRoot(normalizeTrustedWorkspaceRootPath(prefix), normalized),
    )
  ) {
    return true
  }
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (!home) {
    return false
  }
  const homeRoot = normalizeTrustedWorkspaceRootPath(home)
  if (!pathWithinRoot(homeRoot, normalized)) {
    return false
  }
  return HOME_HIGH_STAKES_SEGMENTS.some((segment) =>
    pathWithinRoot(path.join(homeRoot, segment), normalized),
  )
}

export function validateTrustedWorkspaceRootCandidate(
  params: TrustedWorkspaceRootValidationParams,
): TrustedWorkspaceRootValidationResult {
  const normalizedPath = normalizeTrustedWorkspaceRootPath(params.candidatePath)
  if (params.requireExistingDirectory !== false && !isDirectoryPath(normalizedPath)) {
    return { ok: false, normalizedPath, reason: 'not_directory' }
  }
  if (isBroadTrustedWorkspaceRoot(normalizedPath)) {
    return { ok: false, normalizedPath, reason: 'broad_root' }
  }
  if (isHighStakesTrustedWorkspaceRoot(normalizedPath)) {
    return { ok: false, normalizedPath, reason: 'high_stakes' }
  }
  if (resolveWorkspaceRootMatch(params.repoRoot, [], normalizedPath) !== null) {
    return { ok: false, normalizedPath, reason: 'inside_repo' }
  }
  if (params.requireNonGit !== false && containingGitRoot(normalizedPath)) {
    return { ok: false, normalizedPath, reason: 'inside_git_repo' }
  }
  const normalizedControlPlane = params.controlPlaneDir?.trim()
    ? normalizeTrustedWorkspaceRootPath(params.controlPlaneDir)
    : null
  if (
    normalizedControlPlane &&
    (pathWithinRoot(normalizedControlPlane, normalizedPath) ||
      pathWithinRoot(normalizedPath, normalizedControlPlane))
  ) {
    return { ok: false, normalizedPath, reason: 'control_plane_overlap' }
  }
  if (
    (params.protectedRoots ?? []).some((root) => {
      const normalizedRoot = normalizeTrustedWorkspaceRootPath(root)
      return (
        pathWithinRoot(normalizedRoot, normalizedPath) ||
        pathWithinRoot(normalizedPath, normalizedRoot)
      )
    })
  ) {
    return { ok: false, normalizedPath, reason: 'protected_root_overlap' }
  }
  return { ok: true, normalizedPath }
}

export function isPathWithinTrustedWorkspaceRoots(
  absolutePath: string,
  roots: TrustedWorkspaceRootsFile,
): boolean {
  const resolved = normalizeTrustedWorkspaceRootPath(absolutePath)
  return roots.roots.some((entry) => {
    const root = path.resolve(entry.path)
    return resolved === root || pathWithinRoot(root, resolved)
  })
}

export function addTrustedWorkspaceRoot(
  roots: TrustedWorkspaceRootsFile,
  entry: TrustedWorkspaceRootEntry,
): TrustedWorkspaceRootsFile {
  const normalized = normalizeTrustedWorkspaceRootPath(entry.path)
  const filtered = roots.roots.filter(
    (existing) => normalizeTrustedWorkspaceRootPath(existing.path) !== normalized,
  )
  return {
    version: 1,
    roots: [...filtered, { ...entry, path: normalized }],
  }
}
