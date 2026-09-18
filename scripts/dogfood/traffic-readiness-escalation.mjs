#!/usr/bin/env node
/**
 * Evaluate ADR-012 traffic readiness escalation triggers (E1, E2, E4 partial)
 * from belay metrics --json output. E3 requires rollup history (manual).
 *
 * Usage: node scripts/dogfood/traffic-readiness-escalation.mjs [--days-since-upgrade N] < metrics.json
 */
import { readFileSync } from 'node:fs'

const MIN_SHELL_REVIEWED_BENIGN = 10

function parseArgs(argv) {
  let daysSinceUpgrade = null
  const files = []
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days-since-upgrade') {
      daysSinceUpgrade = Number(argv[i + 1])
      i += 1
      continue
    }
    files.push(argv[i])
  }
  return { daysSinceUpgrade, files }
}

function evaluate(metrics, daysSinceUpgrade) {
  const cohort = metrics.currentCohort ?? {}
  const traffic = cohort.reviewedTraffic ?? {}
  const byKind = traffic.byKind ?? { shell: {}, tool: {} }
  const gateEvents = cohort.gateEvents ?? 0
  const reviewedBenignEvents = traffic.reviewedBenignEvents ?? 0
  const shellBenign = byKind.shell?.reviewedBenignEvents ?? 0
  const toolBlockRate = byKind.tool?.benignBlockRate ?? 0
  const escalations = []

  if (gateEvents >= 500 && reviewedBenignEvents === 0) {
    escalations.push('E1')
  }
  if (
    daysSinceUpgrade != null &&
    daysSinceUpgrade >= 14 &&
    gateEvents >= 200 &&
    reviewedBenignEvents < 10
  ) {
    escalations.push('E2')
  }
  if (toolBlockRate >= 0.02) {
    escalations.push('E4-tool-block-rate')
  }
  if (gateEvents >= 200 && shellBenign < MIN_SHELL_REVIEWED_BENIGN) {
    escalations.push('E4-shell-evidence-below-minimum')
  }

  return {
    gateEvents,
    reviewedBenignEvents,
    shellBenign,
    toolBlockRate,
    daysSinceUpgrade,
    escalations,
  }
}

const { daysSinceUpgrade, files } = parseArgs(process.argv)
const inputs =
  files.length > 0 ? files.map((file) => readFileSync(file, 'utf8')) : [readFileSync(0, 'utf8')]

for (const raw of inputs) {
  const metrics = JSON.parse(raw)
  console.log(JSON.stringify(evaluate(metrics, daysSinceUpgrade), null, 2))
}
