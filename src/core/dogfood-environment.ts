import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

import type { getAdapterLayout } from '../adapters/layouts/index.js'
import { loadLayeredConfig } from '../config-io.js'
import type { AdapterName } from '../types.js'
import {
  effectiveDogfoodEnabled,
  listLinkedWorktreePaths,
  resolveRepoConfig,
} from './linked-worktree-config.js'

export { listLinkedWorktreePaths }

export async function listDogfoodWorkspacePaths(repoRoot: string): Promise<string[]> {
  const candidates = [repoRoot, ...(await listLinkedWorktreePaths(repoRoot))]
  const seen = new Set<string>()
  const workspaces: string[] = []
  for (const candidate of candidates) {
    let identity = path.resolve(candidate)
    try {
      identity = realpathSync(candidate)
    } catch {
      // Keep the resolved lexical path so stale worktrees remain visible to environment checks.
    }
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    workspaces.push(candidate)
  }
  return workspaces
}

export async function detectUndogfoodedLinkedWorktrees(params: {
  repoRoot: string
  adapterName: AdapterName
  layout: ReturnType<typeof getAdapterLayout>
}): Promise<string[]> {
  const repoRootCanonical = realpathSync(params.repoRoot)
  const worktrees = await listLinkedWorktreePaths(params.repoRoot)
  const warnings: string[] = []
  for (const worktreePath of worktrees) {
    let canonicalPath = worktreePath
    try {
      canonicalPath = realpathSync(worktreePath)
    } catch {
      // Keep the original path for warning output when the entry is stale.
    }
    if (canonicalPath === repoRootCanonical) {
      continue
    }

    const worktreeLabel = path.basename(worktreePath)
    try {
      const resolution = await resolveRepoConfig(worktreePath, params.adapterName)
      const layered = await loadLayeredConfig(worktreePath, params.adapterName)
      if (effectiveDogfoodEnabled(layered.config)) {
        continue
      }
      if (resolution.inherited) {
        warnings.push(
          `Dogfood is active here but ${worktreeLabel} inherits non-dogfood config from ${path.basename(resolution.configSourceRoot)} (mode=${layered.config.mode}, unknownLocalEffect=${layered.config.policy.unknownLocalEffect}). Run belay dogfood in that worktree or align the source config.`,
        )
        continue
      }
      if (!existsSync(params.layout.configPath(worktreePath))) {
        warnings.push(
          `Dogfood is active here but ${worktreeLabel} has no belay.config.json and no inheritable sibling config was found. Run belay dogfood in each worktree you use with Cursor.`,
        )
        continue
      }
      warnings.push(
        `Dogfood is active here but ${worktreeLabel} is not in dogfood mode (mode=${layered.config.mode}, unknownLocalEffect=${layered.config.policy.unknownLocalEffect}). Run belay dogfood in each worktree you use with Cursor.`,
      )
    } catch {
      warnings.push(
        `Dogfood is active here but ${worktreeLabel} has an unreadable belay.config.json. Run belay doctor and belay dogfood in that worktree.`,
      )
    }
  }
  return warnings
}
