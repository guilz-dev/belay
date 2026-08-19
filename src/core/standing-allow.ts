import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { BelayConfigV4 } from './config.js'
import { belayStateDir } from './config.js'
import type { GatedActionKind } from './gate-contract.js'

export type StandingAllowSource = 'operator' | 'availability-reconfirmed'

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

const EMPTY_STANDING_ALLOW: StandingAllowFile = {
  version: 1,
  entries: [],
}

export function standingAllowFile(config: BelayConfigV4, repoLocalStateDir: string): string {
  return `${belayStateDir(config, repoLocalStateDir)}/standing-allow.json`
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
