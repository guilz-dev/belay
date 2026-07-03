#!/usr/bin/env node
/**
 * Create or update a GitHub issue when nightly adversarial probe reports FN failures.
 * Runs after strict nightly probe; exits 0 when no failures or when issue creation fails.
 */
import { execSync } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifactDir = path.join(root, 'artifacts', 'quality-loop')
const ISSUE_TITLE = '[quality-loop] adversarial probe failures'

async function latestReport() {
  let entries
  try {
    entries = await readdir(artifactDir)
  } catch {
    return null
  }
  const reports = entries
    .filter((name) => name.startsWith('iteration-') && name.endsWith('.json'))
    .sort()
  if (reports.length === 0) {
    return null
  }
  return path.join(artifactDir, reports[reports.length - 1])
}

function formatHoldoutFnRate(report) {
  if (report.holdoutFnRate === null || report.holdoutFnRate === undefined) {
    return 'n/a (holdout empty)'
  }
  return `${(report.holdoutFnRate * 100).toFixed(1)}%`
}

function formatRate(value) {
  if (value === null || value === undefined) {
    return 'n/a'
  }
  return `${(value * 100).toFixed(1)}%`
}

function formatReproductionArgs(report) {
  const parts = [`--seed ${report.seed}`]
  if (report.maxCases !== undefined) {
    parts.push(`--max-cases ${report.maxCases}`)
  }
  if (report.holdoutRatio !== undefined && report.holdoutRatio !== 0.2) {
    parts.push(`--holdout-ratio ${report.holdoutRatio}`)
  }
  parts.push('--strict')
  return parts.join(' ')
}

function formatIssueBody(report) {
  const lines = [
    '## Quality loop failure (nightly strict)',
    '',
    `- batchId: ${report.batchId}`,
    `- seed: ${report.seed}`,
    `- maxCases: ${report.maxCases ?? 'all'}`,
    `- firstPassFnRate: ${formatRate(report.firstPassFnRate)}`,
    `- firstPassFpRate: ${formatRate(report.firstPassFpRate)}`,
    `- holdoutFnRate: ${formatHoldoutFnRate(report)}`,
    `- holdoutFixFnRateRatio: ${report.holdoutFixFnRateRatio === null || report.holdoutFixFnRateRatio === undefined ? 'n/a' : report.holdoutFixFnRateRatio.toFixed(2)}`,
    '',
    '### Failures',
    '',
  ]

  for (const failure of report.failures.slice(0, 20)) {
    lines.push(
      `#### ${failure.mutatorId} / ${failure.core}`,
      '',
      `- command: \`${failure.command}\``,
      `- expected: ${failure.expected}`,
      `- actual: ${failure.actual}`,
      `- reason: ${failure.reason}`,
      '',
      '**Reproduction:**',
      '```bash',
      `pnpm probe:adversarial ${formatReproductionArgs(report)}`,
      '```',
      '',
    )
  }

  return lines.join('\n')
}

function findOpenIssueNumber() {
  try {
    const output = execSync(
      `gh issue list --search ${JSON.stringify(ISSUE_TITLE)} --state open --json number,title --limit 20`,
      { encoding: 'utf8' },
    )
    const issues = JSON.parse(output)
    const match = issues.find((issue) => issue.title.startsWith(ISSUE_TITLE))
    return match?.number ?? null
  } catch {
    return null
  }
}

async function main() {
  const reportPath = await latestReport()
  if (!reportPath) {
    console.log('No probe report found; skipping issue creation.')
    return
  }

  const probeReport = JSON.parse(await readFile(reportPath, 'utf8'))
  if (!probeReport.failures || probeReport.failures.length === 0) {
    console.log('No failures in probe report; skipping issue creation.')
    return
  }

  const bodyPath = path.join(root, 'tmp', 'quality-loop-issue.md')
  await writeFile(bodyPath, formatIssueBody(probeReport), 'utf8')

  const existingIssue = findOpenIssueNumber()
  try {
    if (existingIssue) {
      execSync(`gh issue comment ${existingIssue} --body-file ${JSON.stringify(bodyPath)}`, {
        stdio: 'inherit',
      })
      console.log(`Updated quality-loop failure issue #${existingIssue}.`)
      return
    }

    const title = `${ISSUE_TITLE} (${probeReport.batchId})`
    execSync(
      `gh issue create --title ${JSON.stringify(title)} --body-file ${JSON.stringify(bodyPath)}`,
      { stdio: 'inherit' },
    )
    console.log('Opened quality-loop failure issue.')
  } catch (error) {
    console.warn('Failed to open or update issue (artifact preserved):', error)
  }
}

await main()
