import { existsSync } from 'node:fs'
import path from 'node:path'

import type { AdapterLayout } from '../layouts/types.js'

function belayConfigPath(current: string, adapterName: AdapterLayout['name']): string {
  if (adapterName === 'cursor') {
    return path.join(current, '.cursor', 'belay.config.json')
  }
  if (adapterName === 'claude') {
    return path.join(current, '.claude', 'belay.config.json')
  }
  return path.join(current, '.codex', 'belay.config.json')
}

function markerMatches(current: string, marker: string, layout: AdapterLayout): boolean {
  const markerPath = path.join(current, marker)
  if (!existsSync(markerPath)) {
    return false
  }
  if (marker === '.cursor' || marker === '.claude' || marker === '.codex') {
    return existsSync(belayConfigPath(current, layout.name))
  }
  return true
}

export function findRepoRoot(startPath: string, layout: AdapterLayout): string {
  let current = path.resolve(startPath)
  while (true) {
    for (const marker of layout.repoRootMarkers) {
      if (markerMatches(current, marker, layout)) {
        return current
      }
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return path.resolve(startPath)
    }
    current = parent
  }
}
