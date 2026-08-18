import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { HookVerdict } from '../core/types.js'

export const COVERAGE_MATRIX_VERSION = 1 as const

/** Phase 1 contexts. Phase 2 adds `audit`. */
export const COVERAGE_CONTEXT_IDS = ['default', 'structural'] as const
export type CoverageContextId = (typeof COVERAGE_CONTEXT_IDS)[number]

export interface CoverageExpectation {
  verdict: HookVerdict
  reason?: string
}

export interface CoverageMatrixCase {
  id: string
  command: string
  tags: string[]
  expectations?: Partial<Record<CoverageContextId, CoverageExpectation>>
  notes?: string
}

export interface CoverageMatrixGroup {
  id: string
  label: string
  cases: CoverageMatrixCase[]
}

export interface CoverageMatrix {
  version: typeof COVERAGE_MATRIX_VERSION
  groups: CoverageMatrixGroup[]
}

export class CoverageMatrixSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoverageMatrixSchemaError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseVerdict(value: unknown, pathLabel: string): HookVerdict {
  if (value !== 'allow' && value !== 'allow_flagged' && value !== 'deny_pending_approval') {
    throw new CoverageMatrixSchemaError(`${pathLabel}.verdict is invalid: ${JSON.stringify(value)}`)
  }
  return value
}

function parseExpectation(value: unknown, pathLabel: string): CoverageExpectation {
  if (!isRecord(value)) {
    throw new CoverageMatrixSchemaError(`${pathLabel} must be an object`)
  }
  const expectation: CoverageExpectation = {
    verdict: parseVerdict(value.verdict, pathLabel),
  }
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string' || value.reason.trim() === '') {
      throw new CoverageMatrixSchemaError(`${pathLabel}.reason must be a non-empty string`)
    }
    expectation.reason = value.reason
  }
  return expectation
}

function parseCase(raw: unknown, groupId: string, index: number): CoverageMatrixCase {
  const pathLabel = `group[${groupId}].cases[${index}]`
  if (!isRecord(raw)) {
    throw new CoverageMatrixSchemaError(`${pathLabel} must be an object`)
  }
  if (typeof raw.id !== 'string' || raw.id.trim() === '') {
    throw new CoverageMatrixSchemaError(`${pathLabel}.id must be a non-empty string`)
  }
  if (typeof raw.command !== 'string' || raw.command.trim() === '') {
    throw new CoverageMatrixSchemaError(`${pathLabel}.command must be a non-empty string`)
  }
  if (!Array.isArray(raw.tags) || raw.tags.length === 0) {
    throw new CoverageMatrixSchemaError(`${pathLabel}.tags must be a non-empty array`)
  }
  for (const tag of raw.tags) {
    if (typeof tag !== 'string' || tag.trim() === '') {
      throw new CoverageMatrixSchemaError(`${pathLabel}.tags entries must be non-empty strings`)
    }
  }

  let expectations: CoverageMatrixCase['expectations']
  if (raw.expectations !== undefined) {
    if (!isRecord(raw.expectations)) {
      throw new CoverageMatrixSchemaError(`${pathLabel}.expectations must be an object`)
    }
    expectations = {}
    for (const [contextId, expectationRaw] of Object.entries(raw.expectations)) {
      if (!COVERAGE_CONTEXT_IDS.includes(contextId as CoverageContextId)) {
        throw new CoverageMatrixSchemaError(
          `${pathLabel}.expectations.${contextId} is unknown (allowed: ${COVERAGE_CONTEXT_IDS.join(', ')})`,
        )
      }
      expectations[contextId as CoverageContextId] = parseExpectation(
        expectationRaw,
        `${pathLabel}.expectations.${contextId}`,
      )
    }
  }

  if (raw.notes !== undefined && typeof raw.notes !== 'string') {
    throw new CoverageMatrixSchemaError(`${pathLabel}.notes must be a string`)
  }

  return {
    id: raw.id,
    command: raw.command,
    tags: raw.tags as string[],
    expectations,
    notes: raw.notes,
  }
}

export function parseCoverageMatrix(raw: unknown): CoverageMatrix {
  if (!isRecord(raw)) {
    throw new CoverageMatrixSchemaError('coverage matrix root must be an object')
  }
  if (raw.version !== COVERAGE_MATRIX_VERSION) {
    throw new CoverageMatrixSchemaError(
      `coverage matrix version must be ${COVERAGE_MATRIX_VERSION} (got ${JSON.stringify(raw.version)})`,
    )
  }
  if (!Array.isArray(raw.groups) || raw.groups.length === 0) {
    throw new CoverageMatrixSchemaError('coverage matrix groups must be a non-empty array')
  }

  const groupIds = new Set<string>()
  const caseIds = new Set<string>()
  const groups: CoverageMatrixGroup[] = []

  for (let groupIndex = 0; groupIndex < raw.groups.length; groupIndex += 1) {
    const groupRaw = raw.groups[groupIndex]
    if (!isRecord(groupRaw)) {
      throw new CoverageMatrixSchemaError(`groups[${groupIndex}] must be an object`)
    }
    if (typeof groupRaw.id !== 'string' || groupRaw.id.trim() === '') {
      throw new CoverageMatrixSchemaError(`groups[${groupIndex}].id must be a non-empty string`)
    }
    if (groupIds.has(groupRaw.id)) {
      throw new CoverageMatrixSchemaError(`duplicate group id: ${groupRaw.id}`)
    }
    groupIds.add(groupRaw.id)

    if (typeof groupRaw.label !== 'string' || groupRaw.label.trim() === '') {
      throw new CoverageMatrixSchemaError(`groups[${groupIndex}].label must be a non-empty string`)
    }
    if (!Array.isArray(groupRaw.cases) || groupRaw.cases.length === 0) {
      throw new CoverageMatrixSchemaError(`group[${groupRaw.id}].cases must be a non-empty array`)
    }

    const cases: CoverageMatrixCase[] = []
    for (let caseIndex = 0; caseIndex < groupRaw.cases.length; caseIndex += 1) {
      const testCase = parseCase(groupRaw.cases[caseIndex], groupRaw.id, caseIndex)
      if (caseIds.has(testCase.id)) {
        throw new CoverageMatrixSchemaError(`duplicate case id: ${testCase.id}`)
      }
      caseIds.add(testCase.id)
      cases.push(testCase)
    }

    groups.push({
      id: groupRaw.id,
      label: groupRaw.label,
      cases,
    })
  }

  return {
    version: COVERAGE_MATRIX_VERSION,
    groups,
  }
}

export async function loadCoverageMatrix(matrixPath: string): Promise<CoverageMatrix> {
  const raw = JSON.parse(await readFile(matrixPath, 'utf8'))
  return parseCoverageMatrix(raw)
}

export function flattenCoverageCases(
  matrix: CoverageMatrix,
): Array<CoverageMatrixCase & { groupId: string; groupLabel: string }> {
  const flat: Array<CoverageMatrixCase & { groupId: string; groupLabel: string }> = []
  for (const group of matrix.groups) {
    for (const testCase of group.cases) {
      flat.push({ ...testCase, groupId: group.id, groupLabel: group.label })
    }
  }
  return flat
}

export function defaultCoverageMatrixPath(repoRoot: string): string {
  return path.join(repoRoot, 'corpus', 'coverage-matrix.json')
}

export function assertKnownContextIds(contextIds: string[]): CoverageContextId[] {
  if (contextIds.length === 0) {
    throw new CoverageMatrixSchemaError('at least one context is required')
  }
  const parsed: CoverageContextId[] = []
  for (const contextId of contextIds) {
    if (!COVERAGE_CONTEXT_IDS.includes(contextId as CoverageContextId)) {
      throw new CoverageMatrixSchemaError(
        `unknown context ${JSON.stringify(contextId)} (allowed: ${COVERAGE_CONTEXT_IDS.join(', ')})`,
      )
    }
    parsed.push(contextId as CoverageContextId)
  }
  return parsed
}
