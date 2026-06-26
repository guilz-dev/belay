import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { STANDING_ALLOW_CATALOG } from '../corpus/standing-allow-catalog.generated.js'
import type { BelayConfigV4 } from './config.js'
import { belayStateDir } from './config.js'
import type { GatedActionKind } from './gate-contract.js'
import type { ClassifyResult } from './types.js'

export type StandingAllowSource =
  | 'provably-benign-corpus'
  | 'must-allow-catalog'
  | 'operator'
  | 'availability-reconfirmed'

export interface StandingAllowEntry {
  kind: GatedActionKind
  fingerprint: string
  source: StandingAllowSource
  reason: string
  summary?: string
  createdAt: string
  expiresAt: string
  repoRoot?: string
}

export interface StandingAllowFile {
  version: 1
  entries: StandingAllowEntry[]
}

export interface StandingAllowMatch {
  source: StandingAllowSource
  catalogCommand?: string
  entryId?: string
}

const EMPTY_STANDING_ALLOW: StandingAllowFile = {
  version: 1,
  entries: [],
}

/** Default TTL for operator / availability-reconfirmed standing-allow entries. */
export const DEFAULT_STANDING_ALLOW_TTL_MS = 30 * 24 * 60 * 60 * 1000

const PROVABLY_BENIGN_COMMANDS = new Set(
  STANDING_ALLOW_CATALOG.shell.provablyBenign.map((entry) => entry.normalizedCommand),
)

const MUST_ALLOW_COMMANDS = new Set(
  STANDING_ALLOW_CATALOG.shell.mustAllow.map((entry) => entry.normalizedCommand),
)

/** Reasons that must never be silenced via standing-allow (defense in depth with signal checks). */
const STANDING_ALLOW_BLOCKED_REASONS = new Set([
  'external_effect',
  'tier1_catastrophic',
  'protected_artifact',
  'pipe_to_shell',
  'command_substitution',
])

export function standingAllowFile(config: BelayConfigV4, repoLocalStateDir: string): string {
  return `${belayStateDir(config, repoLocalStateDir)}/standing-allow.json`
}

export function isTier0StandingAllowBlocked(result: ClassifyResult): boolean {
  if (result.reason.startsWith('tier0_') || STANDING_ALLOW_BLOCKED_REASONS.has(result.reason)) {
    return true
  }
  const signals = result.assessment?.signals ?? []
  return signals.some((signal) => signal === 'tier0_external' || signal === 'tier1_catastrophic')
}

function isExpired(iso: string, now = Date.now()): boolean {
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) || parsed <= now
}

export function compactStandingAllow(
  state: StandingAllowFile,
  now = Date.now(),
): StandingAllowFile {
  return {
    version: 1,
    entries: state.entries.filter((entry) => !isExpired(entry.expiresAt, now)),
  }
}

function sanitizeStandingAllowEntries(input: unknown): StandingAllowEntry[] {
  if (!Array.isArray(input)) {
    return []
  }
  return input.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }
    const record = entry as Record<string, unknown>
    if (
      (record.kind !== 'shell' && record.kind !== 'tool' && record.kind !== 'subagent') ||
      typeof record.fingerprint !== 'string' ||
      !record.fingerprint.trim() ||
      typeof record.expiresAt !== 'string' ||
      typeof record.createdAt !== 'string' ||
      typeof record.reason !== 'string'
    ) {
      return []
    }
    const source = record.source
    if (source !== 'operator' && source !== 'availability-reconfirmed') {
      return []
    }
    return [
      {
        kind: record.kind,
        fingerprint: record.fingerprint,
        source,
        reason: record.reason,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
        ...(typeof record.repoRoot === 'string' ? { repoRoot: record.repoRoot } : {}),
      },
    ]
  })
}

export async function loadStandingAllow(filePath: string): Promise<StandingAllowFile> {
  if (!existsSync(filePath)) {
    return { ...EMPTY_STANDING_ALLOW }
  }
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as StandingAllowFile
  const rawCount = Array.isArray(raw.entries) ? raw.entries.length : 0
  const entries = sanitizeStandingAllowEntries(raw.entries)
  const compacted = compactStandingAllow({ version: 1, entries })
  if (rawCount !== compacted.entries.length || entries.length !== compacted.entries.length) {
    await saveStandingAllow(filePath, compacted)
  }
  return compacted
}

export async function saveStandingAllow(filePath: string, state: StandingAllowFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const compacted = compactStandingAllow(state)
  await writeFile(filePath, `${JSON.stringify(compacted, null, 2)}\n`, 'utf8')
}

function matchBundledCatalog(
  kind: GatedActionKind,
  normalizedCommand: string,
): StandingAllowMatch | null {
  if (kind !== 'shell' || !normalizedCommand) {
    return null
  }
  if (PROVABLY_BENIGN_COMMANDS.has(normalizedCommand)) {
    return { source: 'provably-benign-corpus', catalogCommand: normalizedCommand }
  }
  if (MUST_ALLOW_COMMANDS.has(normalizedCommand)) {
    return { source: 'must-allow-catalog', catalogCommand: normalizedCommand }
  }
  return null
}

function matchStateEntry(params: {
  kind: GatedActionKind
  fingerprint: string
  repoRoot: string
  state: StandingAllowFile
  now?: number
}): StandingAllowMatch | null {
  const now = params.now ?? Date.now()
  const match = params.state.entries.find(
    (entry) =>
      entry.kind === params.kind &&
      entry.fingerprint === params.fingerprint &&
      !isExpired(entry.expiresAt, now) &&
      (entry.repoRoot === undefined || entry.repoRoot === params.repoRoot),
  )
  if (!match) {
    return null
  }
  return { source: match.source, entryId: match.fingerprint }
}

export function resolveStandingAllowMatch(params: {
  kind: GatedActionKind
  result: ClassifyResult
  repoRoot: string
  state: StandingAllowFile
  now?: number
}): StandingAllowMatch | null {
  if (params.result.verdict !== 'deny_pending_approval') {
    return null
  }
  if (isTier0StandingAllowBlocked(params.result)) {
    return null
  }

  const normalizedCommand = params.result.normalizedCommand ?? params.result.summary ?? ''
  const catalogMatch = matchBundledCatalog(params.kind, normalizedCommand)
  if (catalogMatch) {
    return catalogMatch
  }

  return matchStateEntry({
    kind: params.kind,
    fingerprint: params.result.fingerprint,
    repoRoot: params.repoRoot,
    state: params.state,
    now: params.now,
  })
}

export function addStandingAllowEntry(
  state: StandingAllowFile,
  entry: Omit<StandingAllowEntry, 'createdAt' | 'expiresAt'> & {
    createdAt?: string
    expiresAt?: string
    ttlMs?: number
  },
): StandingAllowFile {
  const createdAt = entry.createdAt ?? new Date().toISOString()
  const ttlMs = entry.ttlMs ?? DEFAULT_STANDING_ALLOW_TTL_MS
  const expiresAt = entry.expiresAt ?? new Date(Date.parse(createdAt) + ttlMs).toISOString()
  const next: StandingAllowEntry = {
    kind: entry.kind,
    fingerprint: entry.fingerprint,
    source: entry.source,
    reason: entry.reason,
    createdAt,
    expiresAt,
    ...(entry.summary ? { summary: entry.summary } : {}),
    ...(entry.repoRoot ? { repoRoot: entry.repoRoot } : {}),
  }
  const filtered = state.entries.filter(
    (existing) =>
      !(
        existing.kind === next.kind &&
        existing.fingerprint === next.fingerprint &&
        existing.repoRoot === next.repoRoot
      ),
  )
  return compactStandingAllow({
    version: 1,
    entries: [...filtered, next],
  })
}

export function revokeStandingAllowEntry(
  state: StandingAllowFile,
  params: { kind: GatedActionKind; fingerprint: string; repoRoot?: string },
): { state: StandingAllowFile; removed: boolean } {
  const before = state.entries.length
  const entries = state.entries.filter((entry) => {
    if (entry.kind !== params.kind || entry.fingerprint !== params.fingerprint) {
      return true
    }
    if (params.repoRoot && entry.repoRoot && entry.repoRoot !== params.repoRoot) {
      return true
    }
    return false
  })
  return {
    state: { version: 1, entries },
    removed: entries.length < before,
  }
}
