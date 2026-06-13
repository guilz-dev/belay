import path from 'node:path'

import { metricsProject } from './commands/metrics.js'
import { loadConfigFile } from './config-io.js'
import type { BelayConfigV3 } from './core/config.js'

export interface DogfoodStatus {
  active: boolean
  mode: string
  unknownLocalEffect: string
  readyForEnforce: boolean
  gateEvents: number
  wouldBlockCount: number
  wouldBlockRate: number
  notes: string[]
}

export interface OperationalInsights {
  repoRoot: string
  dogfood: DogfoodStatus
}

export function isDogfoodConfig(config: BelayConfigV3): boolean {
  return config.mode === 'audit' && config.policy.unknownLocalEffect === 'deny'
}

export async function loadOperationalInsights(
  options: { targetDir?: string } = {},
): Promise<OperationalInsights> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const metrics = await metricsProject({ targetDir: repoRoot })

  return {
    repoRoot,
    dogfood: {
      active: isDogfoodConfig(config),
      mode: config.mode,
      unknownLocalEffect: config.policy.unknownLocalEffect,
      readyForEnforce: metrics.dogfood.readyForEnforce,
      gateEvents: metrics.gateEvents,
      wouldBlockCount: metrics.wouldBlockCount,
      wouldBlockRate: metrics.wouldBlockRate,
      notes: metrics.dogfood.notes,
    },
  }
}
