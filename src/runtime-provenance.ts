import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { getAdapterLayout } from './adapters/layouts/index.js'
import { resolveScopedPaths } from './adapters/layouts/scope.js'
import { resolveAdapterName } from './config-io.js'
import type { AuditCohortIdentity } from './core/audit-metrics.js'
import type { BelayConfigV3 } from './core/config.js'
import { canonicalStringify, hashValue } from './core/fingerprint.js'

export interface InstalledRuntimeProvenance {
  stamp?: string
  version?: string
}

export async function readInstalledRuntimeProvenance(
  corePath: string,
): Promise<InstalledRuntimeProvenance> {
  try {
    const content = await readFile(corePath, 'utf8')
    const stampMatch = content.match(/RUNTIME_BUILD_STAMP\s*=\s*"([^"]+)"/)
    const versionMatch = content.match(/RUNTIME_PACKAGE_VERSION\s*=\s*"([^"]+)"/)
    return {
      stamp: stampMatch?.[1],
      version: versionMatch?.[1],
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
  return {
    runtimeBuildStamp: runtime.stamp,
    configFingerprint: hashValue(canonicalStringify(config)),
  }
}
