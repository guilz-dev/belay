import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { getAdapterLayout } from './adapters/layouts/index.js'
import { resolveScopedPaths } from './adapters/layouts/scope.js'
import { resolveAdapterName } from './config-io.js'
import { resolveBoundaryProfile } from './core/capability/boundary-profile.js'
import type { AuditCohortIdentity } from './core/audit-metrics.js'
import type { BelayConfigV3 } from './core/config.js'
import { isValidAuditFingerprint } from './core/audit-serialize.js'
import { hashDecisionConfig } from './core/decision-config-fingerprint.js'
import { canonicalStringify, hashValue } from './core/fingerprint.js'
import { PACKAGE_VERSION } from './version.js'

export interface InstalledRuntimeProvenance {
  stamp?: string
  version?: string
  artifactHash?: string
}

export interface RuntimeBuildProvenanceInput {
  runtimeVersion?: unknown
  runtimeBuildStamp?: unknown
  runtimeArtifactHash?: unknown
}

export { hashDecisionConfig } from './core/decision-config-fingerprint.js'

export function resolveRuntimeArtifactHash(artifactHash?: string): string | undefined {
  if (typeof artifactHash === 'string' && isValidAuditFingerprint(artifactHash)) {
    return artifactHash
  }
  return undefined
}

export function buildAuditProvenanceFields(
  config: BelayConfigV3,
  runtime?: RuntimeBuildProvenanceInput,
): Record<string, string> {
  const runtimeVersion =
    typeof runtime?.runtimeVersion === 'string' ? runtime.runtimeVersion : PACKAGE_VERSION
  const runtimeBuildStamp =
    typeof runtime?.runtimeBuildStamp === 'string'
      ? runtime.runtimeBuildStamp
      : `${PACKAGE_VERSION}@source`
  const fields: Record<string, string> = {
    runtimeVersion,
    runtimeBuildStamp,
    decisionConfigFingerprint: hashDecisionConfig(config),
    boundaryProfile: resolveBoundaryProfile({ config }),
    configFingerprint: hashValue(canonicalStringify(config)),
  }
  const runtimeArtifactHash = resolveRuntimeArtifactHash(
    typeof runtime?.runtimeArtifactHash === 'string' ? runtime.runtimeArtifactHash : undefined,
  )
  if (runtimeArtifactHash) {
    fields.runtimeArtifactHash = runtimeArtifactHash
  }
  return fields
}

export function matchesAuditCohort(
  record: Record<string, unknown>,
  cohort: AuditCohortIdentity,
): boolean {
  const artifactHash =
    typeof record.runtimeArtifactHash === 'string' ? record.runtimeArtifactHash : undefined
  const decisionFingerprint =
    typeof record.decisionConfigFingerprint === 'string'
      ? record.decisionConfigFingerprint
      : undefined
  const boundaryProfile =
    typeof record.boundaryProfile === 'string' ? record.boundaryProfile : undefined
  const hasPartialV3Field =
    artifactHash !== undefined || decisionFingerprint !== undefined

  if (hasPartialV3Field) {
    if (
      !artifactHash ||
      !decisionFingerprint ||
      !isValidAuditFingerprint(artifactHash)
    ) {
      return false
    }
    if (
      artifactHash !== cohort.runtimeArtifactHash ||
      decisionFingerprint !== cohort.decisionConfigFingerprint
    ) {
      return false
    }
    if (boundaryProfile && boundaryProfile !== cohort.boundaryProfile) {
      return false
    }
    return true
  }

  return (
    record.runtimeBuildStamp === cohort.runtimeBuildStamp &&
    record.configFingerprint === cohort.configFingerprint
  )
}

export async function readInstalledRuntimeProvenance(
  corePath: string,
): Promise<InstalledRuntimeProvenance> {
  try {
    const content = await readFile(corePath, 'utf8')
    const stampMatch = content.match(/RUNTIME_BUILD_STAMP\s*=\s*"([^"]+)"/)
    const versionMatch = content.match(/RUNTIME_PACKAGE_VERSION\s*=\s*"([^"]+)"/)
    const artifactMatch = content.match(/RUNTIME_ARTIFACT_HASH\s*=\s*"([^"]+)"/)
    return {
      stamp: stampMatch?.[1],
      version: versionMatch?.[1],
      artifactHash: artifactMatch?.[1],
    }
  } catch {
    return {}
  }
}

export async function resolveActiveAuditCohort(
  repoRoot: string,
  config: BelayConfigV3,
): Promise<AuditCohortIdentity | null> {
  const adapter = resolveAdapterName(config)
  const layout = getAdapterLayout(adapter)
  const installScope = config.installScope === 'global' ? 'global' : 'project'
  const scopedPaths = resolveScopedPaths(layout, installScope, repoRoot)
  const runtime = await readInstalledRuntimeProvenance(
    path.join(scopedPaths.runtimeDir, 'core.mjs'),
  )
  if (!runtime.stamp) {
    return null
  }
  const boundaryProfile = resolveBoundaryProfile({ config })
  const decisionConfigFingerprint = hashDecisionConfig(config)
  const runtimeArtifactHash = resolveRuntimeArtifactHash(runtime.artifactHash) ?? ''
  return {
    runtimeArtifactHash,
    decisionConfigFingerprint,
    boundaryProfile,
    runtimeBuildStamp: runtime.stamp,
    configFingerprint: hashValue(canonicalStringify(config)),
  }
}
