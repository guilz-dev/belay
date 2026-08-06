import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDockerAvailable } from '../../core/capability/boundary-driver-container.js'
import * as boundaryEgress from '../../core/capability/boundary-egress.js'
import {
  boundarySessionStatus,
  startBoundarySession,
} from '../../core/capability/boundary-session.js'
import { DEFAULT_CONFIG_V4 } from '../../core/config.js'

const dockerAvailable = await isDockerAvailable()

describe('boundary session', () => {
  let repoRoot = ''

  afterEach(async () => {
    if (repoRoot) {
      await rm(repoRoot, { recursive: true, force: true })
    }
    repoRoot = ''
    vi.restoreAllMocks()
  })

  it('writes attestation on session start', async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-session-'))
    const config = {
      ...DEFAULT_CONFIG_V4,
      version: 5 as const,
      capability: {
        attestationRelPath: '.belay/attestation.json',
      },
    }
    const started = await startBoundarySession({ repoRoot, config })
    const raw = JSON.parse(await readFile(started.attestationPath, 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.attestation.driver).toBe('host-integration')
    expect(typeof raw.signature).toBe('string')
    const status = await boundarySessionStatus({ repoRoot, config })
    expect(status.attestation?.driver).toBe('host-integration')
    expect(status.fresh).toBe(true)
  })

  it.skipIf(!dockerAvailable)(
    'does not write attestation when prepare fails after a successful probe',
    async () => {
      repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-session-prepare-fail-'))
      const config = {
        ...DEFAULT_CONFIG_V4,
        version: 5 as const,
        sandbox: { ...DEFAULT_CONFIG_V4.sandbox, enabled: true, runtime: 'container' as const },
        egress: { ...DEFAULT_CONFIG_V4.egress, enabled: true },
        capability: {
          attestationRelPath: '.belay/attestation.json',
          boundaryDriver: 'container' as const,
        },
      }
      const attestationPath = path.join(repoRoot, '.belay', 'attestation.json')
      vi.spyOn(boundaryEgress, 'ensureBelayContainerNetwork').mockRejectedValueOnce(
        new Error('network create failed'),
      )

      await expect(
        startBoundarySession({
          repoRoot,
          config,
          egressProxyRunning: true,
        }),
      ).rejects.toThrow('network create failed')

      expect(existsSync(attestationPath)).toBe(false)
    },
  )
})
