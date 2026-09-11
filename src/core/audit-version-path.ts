import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { getAdapterLayout } from '../adapters/layouts/index.js'
import { resolveScopedPaths } from '../adapters/layouts/scope.js'
import { resolveAdapterName } from '../config-io.js'
import { readInstalledRuntimeProvenance } from '../runtime-provenance.js'
import { PACKAGE_VERSION } from '../version.js'
import type { BelayConfigV3 } from './config.js'

/** Matches release-scoped audit logs such as v0.12.0.log */
export const VERSIONED_AUDIT_LOG_BASENAME_PATTERN =
  /^v[0-9]+\.[0-9]+\.[0-9]+(?:[.+~][A-Za-z0-9._+-]*)?\.log$/iu

export function versionedAuditLogFileName(version: string): string {
  const trimmed = version.trim()
  if (!trimmed) {
    throw new Error('Audit log version is required')
  }
  const label = trimmed.startsWith('v') ? trimmed : `v${trimmed}`
  const safe = label.replace(/[^v0-9A-Za-z._+-]/gu, '-')
  return `${safe}.log`
}

export function normalizeAuditVersionLabel(version: string): string {
  const trimmed = version.trim()
  if (!trimmed) {
    throw new Error('Audit log version is required')
  }
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed
}

export function resolveAuditLogDirectory(repoRoot: string, configuredLogPath: string): string {
  const resolved = path.isAbsolute(configuredLogPath)
    ? configuredLogPath
    : path.join(repoRoot, configuredLogPath)
  const basename = path.basename(resolved)
  if (
    basename.endsWith('.ndjson') ||
    basename.endsWith('.log') ||
    VERSIONED_AUDIT_LOG_BASENAME_PATTERN.test(basename)
  ) {
    return path.dirname(resolved)
  }
  return resolved
}

export function resolveVersionedAuditLogPath(
  repoRoot: string,
  configuredLogPath: string,
  runtimeVersion: string,
): string {
  const directory = resolveAuditLogDirectory(repoRoot, configuredLogPath)
  return path.join(directory, versionedAuditLogFileName(runtimeVersion))
}

export async function resolveInstalledRuntimeVersion(
  repoRoot: string,
  config: BelayConfigV3,
): Promise<string> {
  const adapter = resolveAdapterName(config)
  const layout = getAdapterLayout(adapter)
  const installScope = config.installScope === 'global' ? 'global' : 'project'
  const scopedPaths = resolveScopedPaths(layout, installScope, repoRoot)
  const runtime = await readInstalledRuntimeProvenance(
    path.join(scopedPaths.runtimeDir, 'core.mjs'),
  )
  return runtime.version ?? PACKAGE_VERSION
}

export async function resolveActiveAuditLogPath(
  repoRoot: string,
  config: BelayConfigV3,
): Promise<string> {
  const runtimeVersion = await resolveInstalledRuntimeVersion(repoRoot, config)
  return resolveVersionedAuditLogPath(repoRoot, config.audit.logPath, runtimeVersion)
}

function versionedAuditGenerationPaths(directory: string, baseName: string): string[] {
  const escapedName = baseName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const generationPattern = new RegExp(`^${escapedName}\\.(\\d+)$`, 'u')
  const paths: string[] = []
  try {
    for (const entry of readdirSync(directory)) {
      const match = entry.match(generationPattern)
      if (!match) {
        continue
      }
      const generation = Number(match[1])
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        continue
      }
      paths.push(path.join(directory, entry))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  return paths.sort((left, right) => left.localeCompare(right))
}

/** Forensic mode only — default metrics/report read the active version file. */
export function listVersionedAuditLogRoots(directory: string): string[] {
  let entries: string[] = []
  try {
    entries = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }

  const roots = entries
    .filter((entry) => VERSIONED_AUDIT_LOG_BASENAME_PATTERN.test(entry))
    .map((entry) => path.join(directory, entry))
    .filter((filePath) => existsSync(filePath))

  return roots.sort((left, right) => left.localeCompare(right))
}

export function listAllVersionedAuditLogPaths(directory: string): string[] {
  const paths = new Set<string>()
  for (const root of listVersionedAuditLogRoots(directory)) {
    paths.add(root)
    for (const generationPath of versionedAuditGenerationPaths(directory, path.basename(root))) {
      paths.add(generationPath)
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right))
}

export interface AuditReadScopeOptions {
  auditVersion?: string
  allVersions?: boolean
}

export interface ResolvedAuditReadScope {
  mode: 'active' | 'version' | 'all'
  version?: string
  paths: string[]
  primaryPath: string
  forensic: boolean
}

export async function resolveAuditLogReadScope(
  repoRoot: string,
  config: BelayConfigV3,
  options: AuditReadScopeOptions = {},
): Promise<ResolvedAuditReadScope> {
  if (options.auditVersion && options.allVersions) {
    throw new Error('--audit-version and --all-versions are mutually exclusive.')
  }

  const directory = resolveAuditLogDirectory(repoRoot, config.audit.logPath)
  const activeVersion = await resolveInstalledRuntimeVersion(repoRoot, config)
  const activePath = resolveVersionedAuditLogPath(repoRoot, config.audit.logPath, activeVersion)

  if (options.allVersions) {
    const paths = listAllVersionedAuditLogPaths(directory)
    return {
      mode: 'all',
      paths: paths.length > 0 ? paths : [activePath],
      primaryPath: activePath,
      forensic: true,
    }
  }

  if (options.auditVersion) {
    const version = normalizeAuditVersionLabel(options.auditVersion)
    const versionPath = resolveVersionedAuditLogPath(repoRoot, config.audit.logPath, version)
    const normalizedActive = normalizeAuditVersionLabel(activeVersion)
    return {
      mode: 'version',
      version,
      paths: [versionPath],
      primaryPath: versionPath,
      forensic: version !== normalizedActive,
    }
  }

  return {
    mode: 'active',
    version: activeVersion,
    paths: [activePath],
    primaryPath: activePath,
    forensic: false,
  }
}

export function harvestReviewLedgerPath(repoRoot: string, configuredAuditPath: string): string {
  return path.join(resolveAuditLogDirectory(repoRoot, configuredAuditPath), 'harvest-reviews.json')
}
