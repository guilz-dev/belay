import path from 'node:path'

import type { AdapterLayout } from './types.js'

/** Repo-local and optional out-of-repo paths that must never be mutated via overrides. */
export function protectedArtifactRoots(
  layout: AdapterLayout,
  repoRoot: string,
  controlPlaneDir?: string | null,
): string[] {
  const roots = [
    layout.configPath(repoRoot),
    layout.hooksSettingsPath(repoRoot),
    layout.hooksDir(repoRoot),
    layout.repoLocalStateDir(repoRoot),
    layout.runtimeDir(repoRoot),
  ]
  if (controlPlaneDir) {
    roots.push(controlPlaneDir)
  }
  return roots.map((entry) => path.resolve(entry))
}
