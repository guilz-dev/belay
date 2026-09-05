import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import type { getAdapterLayout } from '../adapters/layouts/index.js'
import { loadLayeredConfig } from '../config-io.js'
import type { AdapterName } from '../types.js'

const execFileAsync = promisify(execFile)

export async function listLinkedWorktreePaths(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
      .filter((entry) => entry.length > 0)
  } catch {
    return []
  }
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
    const configPath = params.layout.configPath(worktreePath)
    if (!existsSync(configPath)) {
      warnings.push(
        `Dogfood is active here but ${path.basename(worktreePath)} has no belay.config.json (defaults to enforce). Run belay dogfood in each worktree you use with Cursor.`,
      )
      continue
    }
    try {
      const candidate = await loadLayeredConfig(worktreePath, params.adapterName)
      const dogfoodEnabled =
        candidate.config.mode === 'audit' && candidate.config.policy.unknownLocalEffect === 'deny'
      if (!dogfoodEnabled) {
        warnings.push(
          `Dogfood is active here but ${path.basename(worktreePath)} is not in dogfood mode (mode=${candidate.config.mode}, unknownLocalEffect=${candidate.config.policy.unknownLocalEffect}). Run belay dogfood in each worktree you use with Cursor.`,
        )
      }
    } catch {
      warnings.push(
        `Dogfood is active here but ${path.basename(worktreePath)} has an unreadable belay.config.json. Run belay doctor and belay dogfood in that worktree.`,
      )
    }
  }
  return warnings
}
