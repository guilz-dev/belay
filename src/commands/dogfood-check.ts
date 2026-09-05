import path from 'node:path'

import { getAdapterLayout } from '../adapters/layouts/index.js'
import { detectAdapterName, loadConfigFile } from '../config-io.js'
import { isGateRecord, parseTimestamp } from '../core/audit-query.js'
import { summarizeAuditVisibility } from '../core/audit-summary.js'
import type { AuditRecord } from '../core/audit-types.js'
import { detectUndogfoodedLinkedWorktrees } from '../core/dogfood-environment.js'
import { matchesAuditCohort, resolveActiveAuditCohort } from '../runtime-provenance.js'
import type { DogfoodCheckOptions, DogfoodCheckResult } from '../types.js'
import { loadAuditRecords } from './audit.js'

function isDogfoodMode(config: {
  mode?: unknown
  policy?: { unknownLocalEffect?: unknown }
}): boolean {
  return config.mode === 'audit' && config.policy?.unknownLocalEffect === 'deny'
}

function baseResult(repoRoot: string, since: string): DogfoodCheckResult {
  return {
    ok: false,
    repoRoot,
    since,
    gateEvents: 0,
    auditModeDenyCount: 0,
    hostDeniedAfterAllowCount: 0,
    shellPreToolUseCount: 0,
    mismatchedCohortCount: 0,
    environmentSkewCount: 0,
    failures: [],
  }
}

export async function checkDogfoodProject(
  options: DogfoodCheckOptions,
): Promise<DogfoodCheckResult> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const since = options.since
  const result = baseResult(repoRoot, since)
  const sinceMs = parseTimestamp(since)
  if (sinceMs === null) {
    result.failures.push('invalid_since')
    return result
  }

  const adapter = options.adapter ?? detectAdapterName(repoRoot)
  const config = await loadConfigFile(repoRoot, adapter)
  const dogfoodActive = isDogfoodMode(config)
  if (!dogfoodActive) {
    result.failures.push('dogfood_inactive')
  }

  const records = await loadAuditRecords(repoRoot, adapter)
  const invalidTimestampRecord = records.some((record) => parseTimestamp(record.timestamp) === null)
  if (invalidTimestampRecord) {
    result.failures.push('invalid_timestamp_record')
  }
  const inWindowRecords = records.filter((record) => {
    const recordMs = parseTimestamp(record.timestamp)
    return recordMs !== null && recordMs >= sinceMs
  })

  const activeCohort = await resolveActiveAuditCohort(repoRoot, config)
  const inWindowGateRecords = inWindowRecords.filter((record) => isGateRecord(record))
  let cohortGateRecords: AuditRecord[] = inWindowGateRecords
  let cohortScopedRecords: AuditRecord[] = inWindowRecords
  if (activeCohort) {
    cohortGateRecords = inWindowGateRecords.filter((record) =>
      matchesAuditCohort(record, activeCohort),
    )
    const cohortEventRecords = new Set(cohortGateRecords)
    cohortScopedRecords = inWindowRecords.filter(
      (record) => !isGateRecord(record) || cohortEventRecords.has(record),
    )
    result.mismatchedCohortCount = inWindowGateRecords.length - cohortGateRecords.length
  } else {
    result.mismatchedCohortCount = inWindowGateRecords.length
    if (inWindowGateRecords.length > 0) {
      result.failures.push('active_cohort_unavailable')
    }
  }

  result.gateEvents = cohortGateRecords.length
  result.auditModeDenyCount = cohortGateRecords.filter(
    (record) => record.mode === 'audit' && record.permission === 'deny',
  ).length
  result.shellPreToolUseCount = cohortGateRecords.filter(
    (record) => record.kind === 'shell' && record.event === 'preToolUse',
  ).length

  result.hostDeniedAfterAllowCount =
    summarizeAuditVisibility(cohortScopedRecords).hostDeniedAfterAllowCount

  if (result.gateEvents === 0) {
    result.failures.push('no_gate_events_since_cutoff')
  }
  if (result.auditModeDenyCount > 0) {
    result.failures.push('audit_mode_permission_deny')
  }
  if (result.hostDeniedAfterAllowCount > 0) {
    result.failures.push('host_denied_after_allow')
  }
  if (result.shellPreToolUseCount > 0) {
    result.failures.push('shell_event_recorded_as_preToolUse')
  }
  if (result.mismatchedCohortCount > 0) {
    result.failures.push('mismatched_active_cohort')
  }

  if (dogfoodActive) {
    const environmentWarnings = await detectUndogfoodedLinkedWorktrees({
      repoRoot,
      adapterName: adapter,
      layout: getAdapterLayout(adapter),
    })
    result.environmentSkewCount = environmentWarnings.length
    if (result.environmentSkewCount > 0) {
      result.failures.push('environment_skew')
    }
  }

  result.ok = result.failures.length === 0
  return result
}

export function formatDogfoodCheckResult(result: DogfoodCheckResult): string {
  const lines = [
    `dogfood check for ${result.repoRoot}`,
    `since: ${result.since}`,
    `gate events: ${result.gateEvents}`,
    `audit-mode deny count: ${result.auditModeDenyCount}`,
    `host denied-after-allow count: ${result.hostDeniedAfterAllowCount}`,
    `shell preToolUse count: ${result.shellPreToolUseCount}`,
    `mismatched active cohort count: ${result.mismatchedCohortCount}`,
    `environment skew count: ${result.environmentSkewCount}`,
    `status: ${result.ok ? 'ok' : 'fail'}`,
  ]
  if (!result.ok) {
    lines.push(`failures: ${result.failures.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}
