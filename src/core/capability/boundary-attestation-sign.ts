import { createHmac, timingSafeEqual } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'

import { loadOrCreateApprovalSigningKey } from '../approval-token.js'
import { canonicalStringify } from '../fingerprint.js'
import type { BoundaryAttestation } from './attestation.js'
import { validateBoundaryAttestation } from './attestation.js'

export type BoundaryAttestationFileFormat = 'signed' | 'legacy' | 'missing' | 'invalid'

export interface SignedBoundaryAttestationFile {
  version: 1
  repoRoot: string
  attestation: BoundaryAttestation
  signature: string
}

function signBody(repoRoot: string, attestation: BoundaryAttestation, key: Buffer): string {
  const payload = canonicalStringify({ repoRoot, attestation })
  return createHmac('sha256', key).update(payload).digest('base64url')
}

export async function signBoundaryAttestation(params: {
  repoRoot: string
  attestation: BoundaryAttestation
  controlPlaneDir: string
}): Promise<SignedBoundaryAttestationFile> {
  const key = await loadOrCreateApprovalSigningKey(params.controlPlaneDir)
  const signature = signBody(params.repoRoot, params.attestation, key)
  return {
    version: 1,
    repoRoot: params.repoRoot,
    attestation: params.attestation,
    signature,
  }
}

export async function verifySignedBoundaryAttestation(params: {
  file: unknown
  expectedRepoRoot: string
  controlPlaneDir: string
}): Promise<BoundaryAttestation | null> {
  if (!params.file || typeof params.file !== 'object') {
    return null
  }
  const record = params.file as Partial<SignedBoundaryAttestationFile>
  if (record.version !== 1 || typeof record.repoRoot !== 'string' || !record.attestation) {
    return null
  }
  if (record.repoRoot !== params.expectedRepoRoot) {
    return null
  }
  if (!validateBoundaryAttestation(record.attestation)) {
    return null
  }
  if (typeof record.signature !== 'string' || !record.signature) {
    return null
  }
  const key = await loadOrCreateApprovalSigningKey(params.controlPlaneDir)
  const expected = signBody(record.repoRoot, record.attestation, key)
  const actualBuffer = Buffer.from(record.signature)
  const expectedBuffer = Buffer.from(expected)
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null
  }
  return record.attestation
}

export async function readSignedAttestationFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown
}

export function isLegacyAttestationFormat(file: unknown): file is BoundaryAttestation {
  if (!file || typeof file !== 'object') {
    return false
  }
  const record = file as Record<string, unknown>
  return (
    record.version === 1 &&
    typeof record.driver === 'string' &&
    !('signature' in record) &&
    !('attestation' in record)
  )
}

export async function inspectBoundaryAttestationFile(
  filePath: string,
): Promise<BoundaryAttestationFileFormat> {
  try {
    await access(filePath)
  } catch {
    return 'missing'
  }
  try {
    const raw = await readSignedAttestationFile(filePath)
    if (isLegacyAttestationFormat(raw)) {
      return validateBoundaryAttestation(raw) ? 'legacy' : 'invalid'
    }
    const record = raw as Partial<SignedBoundaryAttestationFile>
    if (
      record.version === 1 &&
      typeof record.repoRoot === 'string' &&
      record.attestation &&
      typeof record.signature === 'string'
    ) {
      return 'signed'
    }
    return 'invalid'
  } catch {
    return 'invalid'
  }
}
