import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import { isValidAuditFingerprint, isValidAuditTimestamp } from './audit-serialize.js'

export type HarvestReviewOutcome = 'provably-benign' | 'accepted-benign' | 'must-ask' | 'reject'

export interface HarvestReviewRecordV1 {
  fingerprint: string
  kind: 'shell'
  boundaryProfile: string
  outcome: HarvestReviewOutcome
  reason?: string
  reviewedAt: string
}

export interface HarvestReviewLedgerV1 {
  version: 1
  reviews: HarvestReviewRecordV1[]
}

export interface HarvestReviewWriteOptions {
  rename?: typeof rename
}

export class HarvestReviewLedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarvestReviewLedgerError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function isValidBoundaryProfile(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !hasControlCharacter(value) &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..')
  )
}

function isHarvestReviewOutcome(value: unknown): value is HarvestReviewOutcome {
  return (
    value === 'provably-benign' ||
    value === 'accepted-benign' ||
    value === 'must-ask' ||
    value === 'reject'
  )
}

function parseReview(value: unknown, index: number): HarvestReviewRecordV1 {
  if (!isRecord(value)) {
    throw new HarvestReviewLedgerError(`harvest review[${index}] must be an object`)
  }
  if (typeof value.fingerprint !== 'string' || !isValidAuditFingerprint(value.fingerprint)) {
    throw new HarvestReviewLedgerError(`harvest review[${index}].fingerprint is invalid`)
  }
  if (value.kind !== 'shell') {
    throw new HarvestReviewLedgerError(`harvest review[${index}].kind must be shell`)
  }
  if (typeof value.boundaryProfile !== 'string' || !isValidBoundaryProfile(value.boundaryProfile)) {
    throw new HarvestReviewLedgerError(`harvest review[${index}].boundaryProfile is invalid`)
  }
  if (!isHarvestReviewOutcome(value.outcome)) {
    throw new HarvestReviewLedgerError(`harvest review[${index}].outcome is invalid`)
  }
  if (typeof value.reviewedAt !== 'string' || !isValidAuditTimestamp(value.reviewedAt)) {
    throw new HarvestReviewLedgerError(`harvest review[${index}].reviewedAt is invalid`)
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    throw new HarvestReviewLedgerError(`harvest review[${index}].reason must be a string`)
  }

  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
  return {
    fingerprint: value.fingerprint,
    kind: 'shell',
    boundaryProfile: value.boundaryProfile,
    outcome: value.outcome,
    ...(reason ? { reason } : {}),
    reviewedAt: value.reviewedAt,
  }
}

function parseLedger(value: unknown): HarvestReviewLedgerV1 {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.reviews)) {
    throw new HarvestReviewLedgerError('harvest review ledger must be version 1 with reviews')
  }
  return {
    version: 1,
    reviews: value.reviews.map(parseReview),
  }
}

function reviewKey(
  review: Pick<HarvestReviewRecordV1, 'fingerprint' | 'kind' | 'boundaryProfile'>,
) {
  return `${review.fingerprint}\u0000${review.kind}\u0000${review.boundaryProfile}`
}

export function latestHarvestReviews(
  ledger: HarvestReviewLedgerV1,
): Map<string, HarvestReviewRecordV1> {
  const parsed = parseLedger(ledger)
  const latest = new Map<string, HarvestReviewRecordV1>()
  for (const review of parsed.reviews) {
    const key = reviewKey(review)
    const previous = latest.get(key)
    if (!previous || Date.parse(review.reviewedAt) >= Date.parse(previous.reviewedAt)) {
      latest.set(key, review)
    }
  }
  return latest
}

function normalizedLedger(ledger: HarvestReviewLedgerV1): HarvestReviewLedgerV1 {
  return {
    version: 1,
    reviews: [...latestHarvestReviews(ledger).values()].sort((left, right) =>
      reviewKey(left).localeCompare(reviewKey(right)),
    ),
  }
}

export async function loadHarvestReviewLedger(filePath: string): Promise<HarvestReviewLedgerV1> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, reviews: [] }
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HarvestReviewLedgerError('harvest review ledger is not valid JSON')
  }
  return parseLedger(parsed)
}

export async function writeHarvestReviewLedgerAtomic(
  filePath: string,
  ledger: HarvestReviewLedgerV1,
  options: HarvestReviewWriteOptions = {},
): Promise<void> {
  const normalized = normalizedLedger(ledger)
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  const renameFile = options.rename ?? rename
  let handle: Awaited<ReturnType<typeof open>> | null = null
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await renameFile(temporaryPath, filePath)
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined)
    }
    await unlink(temporaryPath).catch(() => undefined)
  }
}
