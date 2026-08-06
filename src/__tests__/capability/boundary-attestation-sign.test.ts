import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { BoundaryAttestation } from '../../core/capability/attestation.js'
import {
  inspectBoundaryAttestationFile,
  readSignedAttestationFile,
  signBoundaryAttestation,
  verifySignedBoundaryAttestation,
} from '../../core/capability/boundary-attestation-sign.js'

describe('boundary attestation signing', () => {
  let controlPlaneDir = ''

  afterEach(async () => {
    if (controlPlaneDir) {
      await rm(controlPlaneDir, { recursive: true, force: true })
      controlPlaneDir = ''
    }
  })

  const attestation: BoundaryAttestation = {
    version: 1,
    driver: 'host-integration',
    probedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    deniesUngrantedEffects: false,
    materializesGrants: false,
    probeSignals: ['host-integration'],
  }

  it('signs and verifies attestation payloads', async () => {
    controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-attest-'))
    const repoRoot = '/repo'
    const signed = await signBoundaryAttestation({
      repoRoot,
      attestation,
      controlPlaneDir,
    })
    const verified = await verifySignedBoundaryAttestation({
      file: signed,
      expectedRepoRoot: repoRoot,
      controlPlaneDir,
    })
    expect(verified?.driver).toBe('host-integration')
  })

  it('rejects tampered attestation files', async () => {
    controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-attest-'))
    const repoRoot = '/repo'
    const signed = await signBoundaryAttestation({
      repoRoot,
      attestation,
      controlPlaneDir,
    })
    const tampered = {
      ...signed,
      attestation: { ...signed.attestation, driver: 'container' as const },
    }
    const verified = await verifySignedBoundaryAttestation({
      file: tampered,
      expectedRepoRoot: repoRoot,
      controlPlaneDir,
    })
    expect(verified).toBeNull()
  })

  it('rejects attestation for a different repo root', async () => {
    controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-attest-'))
    const signed = await signBoundaryAttestation({
      repoRoot: '/repo-a',
      attestation,
      controlPlaneDir,
    })
    const verified = await verifySignedBoundaryAttestation({
      file: signed,
      expectedRepoRoot: '/repo-b',
      controlPlaneDir,
    })
    expect(verified).toBeNull()
  })

  it('reads signed attestation from disk', async () => {
    controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-attest-'))
    const filePath = path.join(controlPlaneDir, 'attestation.json')
    const signed = await signBoundaryAttestation({
      repoRoot: '/repo',
      attestation,
      controlPlaneDir,
    })
    await writeFile(filePath, JSON.stringify(signed))
    const raw = await readSignedAttestationFile(filePath)
    expect((raw as { signature?: string }).signature).toBe(signed.signature)
    const onDisk = JSON.parse(await readFile(filePath, 'utf8'))
    expect(onDisk.attestation.driver).toBe('host-integration')
  })

  it('classifies signed, legacy, and missing attestation files', async () => {
    controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-attest-'))
    const missingPath = path.join(controlPlaneDir, 'missing.json')
    expect(await inspectBoundaryAttestationFile(missingPath)).toBe('missing')

    const legacyPath = path.join(controlPlaneDir, 'legacy.json')
    await writeFile(legacyPath, JSON.stringify(attestation))
    expect(await inspectBoundaryAttestationFile(legacyPath)).toBe('legacy')

    const signedPath = path.join(controlPlaneDir, 'signed.json')
    const signed = await signBoundaryAttestation({
      repoRoot: '/repo',
      attestation,
      controlPlaneDir,
    })
    await writeFile(signedPath, JSON.stringify(signed))
    expect(await inspectBoundaryAttestationFile(signedPath)).toBe('signed')
  })
})
