import path from 'node:path'

import { loadConfigFile } from '../config-io.js'
import type { AdapterName } from '../types.js'
import { toAuditRecord } from './audit-metrics.js'
import type { AuditReadinessStateSnapshot } from './audit-readiness-state.js'
import {
  type AuditLoadDiagnostics,
  loadRetainedAuditRecords,
  MAX_AUDIT_RECORD_BYTES,
} from './audit-storage.js'
import type { AuditRecord } from './audit-types.js'
import {
  type AuditReadScopeOptions,
  harvestReviewLedgerPath,
  type ResolvedAuditReadScope,
  resolveAuditLogReadScope,
} from './audit-version-path.js'
import { normalizeAuditConfig } from './config.js'

export type { AuditReadScopeOptions, ResolvedAuditReadScope }

export interface LoadedAuditRecords {
  records: AuditRecord[]
  scope: ResolvedAuditReadScope
  diagnostics: AuditLoadDiagnostics
  readinessState: AuditReadinessStateSnapshot
}

interface StampedAuditRecord {
  record: AuditRecord
  sourcePath: string
  sequence: number
}

function compareAuditRecords(left: StampedAuditRecord, right: StampedAuditRecord): number {
  const leftTimestamp = left.record.timestamp ?? ''
  const rightTimestamp = right.record.timestamp ?? ''
  const timestampCompare = leftTimestamp.localeCompare(rightTimestamp)
  if (timestampCompare !== 0) {
    return timestampCompare
  }
  const pathCompare = left.sourcePath.localeCompare(right.sourcePath)
  if (pathCompare !== 0) {
    return pathCompare
  }
  return left.sequence - right.sequence
}

function sortAuditRecords(stampedRecords: StampedAuditRecord[]): AuditRecord[] {
  return [...stampedRecords].sort(compareAuditRecords).map((entry) => entry.record)
}

export async function loadScopedAuditRecords(
  repoRoot: string,
  options: AuditReadScopeOptions & { adapter?: AdapterName } = {},
): Promise<LoadedAuditRecords> {
  const config = await loadConfigFile(repoRoot, options.adapter)
  const audit = normalizeAuditConfig(config.audit)
  const scope = await resolveAuditLogReadScope(repoRoot, config, options)
  const stampedRecords: StampedAuditRecord[] = []
  let diagnostics: AuditLoadDiagnostics = {
    filesRead: 0,
    bytesRead: 0,
    parsedRecords: 0,
    malformedLines: 0,
    oversizedLines: 0,
  }
  let readinessState: AuditReadinessStateSnapshot = { status: 'missing' }

  for (const auditPath of scope.paths) {
    const loaded = await loadRetainedAuditRecords({
      auditPath,
      maxFiles: audit.maxFiles,
      maxLineBytes: MAX_AUDIT_RECORD_BYTES,
    })
    diagnostics = {
      filesRead: diagnostics.filesRead + loaded.diagnostics.filesRead,
      bytesRead: diagnostics.bytesRead + loaded.diagnostics.bytesRead,
      parsedRecords: diagnostics.parsedRecords + loaded.diagnostics.parsedRecords,
      malformedLines: diagnostics.malformedLines + loaded.diagnostics.malformedLines,
      oversizedLines: diagnostics.oversizedLines + loaded.diagnostics.oversizedLines,
    }
    if (auditPath === scope.primaryPath) {
      readinessState = loaded.readinessState
    }
    loaded.records.forEach((record, sequence) => {
      stampedRecords.push({
        record: toAuditRecord(record),
        sourcePath: auditPath,
        sequence,
      })
    })
  }

  return {
    records: sortAuditRecords(stampedRecords),
    scope,
    diagnostics,
    readinessState,
  }
}

export async function loadAuditRecords(
  repoRoot: string,
  adapterOrOptions?: AdapterName | (AuditReadScopeOptions & { adapter?: AdapterName }),
): Promise<AuditRecord[]> {
  const options: AuditReadScopeOptions & { adapter?: AdapterName } =
    typeof adapterOrOptions === 'string' ? { adapter: adapterOrOptions } : (adapterOrOptions ?? {})
  return (await loadScopedAuditRecords(repoRoot, options)).records
}

export function resolveHarvestReviewLedgerPath(
  repoRoot: string,
  configuredAuditPath: string,
): string {
  return harvestReviewLedgerPath(repoRoot, configuredAuditPath)
}

export function auditDirectoryFromConfig(repoRoot: string, configuredAuditPath: string): string {
  return path.dirname(
    path.isAbsolute(configuredAuditPath)
      ? configuredAuditPath
      : path.join(repoRoot, configuredAuditPath),
  )
}
