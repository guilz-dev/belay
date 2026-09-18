import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = path.resolve(
  fileURLToPath(new URL('../../scripts/dogfood/traffic-readiness-escalation.mjs', import.meta.url)),
)

function runEscalation(metrics: unknown, daysSinceUpgrade?: number) {
  const args = [script]
  if (daysSinceUpgrade != null) {
    args.push('--days-since-upgrade', String(daysSinceUpgrade))
  }
  const out = execFileSync(process.execPath, args, {
    input: JSON.stringify(metrics),
    encoding: 'utf8',
  })
  return JSON.parse(out) as { escalations: string[] }
}

describe('traffic-readiness-escalation', () => {
  it('fires E1 when cohort has many gates but zero reviewed benign', () => {
    const result = runEscalation({
      currentCohort: {
        gateEvents: 600,
        reviewedTraffic: {
          reviewedBenignEvents: 0,
          byKind: { shell: { reviewedBenignEvents: 0, benignBlockRate: 0 }, tool: { reviewedBenignEvents: 0, benignBlockRate: 0 } },
        },
      },
    })
    expect(result.escalations).toContain('E1')
  })

  it('fires E2 when upgrade age and low reviewed benign with sufficient gates', () => {
    const result = runEscalation(
      {
        currentCohort: {
          gateEvents: 250,
          reviewedTraffic: {
            reviewedBenignEvents: 5,
            byKind: { shell: { reviewedBenignEvents: 5, benignBlockRate: 0 }, tool: { reviewedBenignEvents: 0, benignBlockRate: 0 } },
          },
        },
      },
      14,
    )
    expect(result.escalations).toContain('E2')
  })
})
