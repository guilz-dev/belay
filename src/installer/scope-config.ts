import { existsSync } from 'node:fs'

import { getAdapterLayout } from '../adapters/layouts/index.js'
import {
  resolveInstallScope,
  resolveScopedPaths,
  type ScopedPaths,
} from '../adapters/layouts/scope.js'
import type { AdapterName } from '../adapters/layouts/types.js'
import { loadConfigFile, writeConfigFile } from '../config-io.js'
import type { BelayConfigV4 } from '../core/config.js'
import type { InitOptions, UpgradeOptions } from '../types.js'

export type OperationScope = 'project' | 'global'

export async function resolveOperationScope(
  repoRoot: string,
  adapter: AdapterName,
  options: InitOptions | UpgradeOptions = {},
): Promise<OperationScope> {
  const layout = getAdapterLayout(adapter)
  let persisted: OperationScope | undefined
  if (existsSync(layout.configPath(repoRoot))) {
    const config = await loadConfigFile(repoRoot, adapter)
    persisted = config.installScope
  }
  return resolveInstallScope(options, persisted)
}

export async function applyInstallScope(
  repoRoot: string,
  adapter: AdapterName,
  scope: OperationScope,
  config?: BelayConfigV4,
): Promise<BelayConfigV4> {
  const current = config ?? (await loadConfigFile(repoRoot, adapter))
  if (current.installScope === scope) {
    return current
  }
  const updated: BelayConfigV4 = { ...current, installScope: scope }
  await writeConfigFile(repoRoot, updated, adapter)
  return updated
}

export function pathsForOperation(
  adapter: AdapterName,
  scope: OperationScope,
  repoRoot: string,
): ScopedPaths {
  return resolveScopedPaths(getAdapterLayout(adapter), scope, repoRoot)
}
