import path from 'node:path'

import { evaluateQualitySnapshot } from './commands/quality.js'
import { loadConfigFile } from './config-io.js'
import type { BelayConfigV3 } from './core/config.js'
import type { AdapterName } from './types.js'

export interface DogfoodStatus {
  active: boolean
  mode: string
  unknownLocalEffect: string
  readyForEnforce: boolean
  trafficReadyForEnforce: boolean
  gateEvents: number
  wouldBlockCount: number
  wouldBlockRate: number
  reviewedBenignEvents: number
  reviewedBenignBlocked: number
  benignBlockRate: number
  distinctSessions: number
  availabilityAsks: number
  availabilityWatermarkStatus:
    | 'not-evaluated'
    | 'missing'
    | 'invalid'
    | 'cohort-mismatch'
    | 'current'
  stickyAvailabilityAsks: number
  excludedGateEvents: number
  runtimeBuildStamp?: string
  configFingerprint?: string
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
  options: { targetDir?: string; adapter?: AdapterName } = {},
): Promise<OperationalInsights> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot, options.adapter)
  const evaluation = await evaluateQualitySnapshot(
    { targetDir: repoRoot, adapter: options.adapter },
    config,
  )
  const { metrics, report: quality } = evaluation
  const cohort = metrics.currentCohort
  const traffic = cohort.reviewedTraffic

  return {
    repoRoot,
    dogfood: {
      active: isDogfoodConfig(config),
      mode: config.mode,
      unknownLocalEffect: config.policy.unknownLocalEffect,
      readyForEnforce: quality.readyForEnforce,
      trafficReadyForEnforce: quality.trafficReadyForEnforce,
      gateEvents: cohort.gateEvents,
      wouldBlockCount: cohort.wouldBlockCount,
      wouldBlockRate: cohort.wouldBlockRate,
      reviewedBenignEvents: traffic.reviewedBenignEvents,
      reviewedBenignBlocked: traffic.reviewedBenignBlocked,
      benignBlockRate: traffic.benignBlockRate,
      distinctSessions: traffic.distinctSessions,
      availabilityAsks: traffic.availabilityAsks,
      availabilityWatermarkStatus: cohort.availabilityWatermark.status,
      stickyAvailabilityAsks: cohort.availabilityWatermark.availabilityAsks,
      excludedGateEvents: cohort.excludedGateEvents,
      runtimeBuildStamp: cohort.identity?.runtimeBuildStamp,
      configFingerprint: cohort.identity?.configFingerprint,
      notes: [...new Set([...metrics.dogfood.notes, ...quality.failedGates])],
    },
  }
}
