import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  boundarySessionStatus,
  startBoundarySession,
} from '../../core/capability/boundary-session.js'
import { DEFAULT_CONFIG_V4 } from '../../core/config.js'

describe('boundary session', () => {
  let repoRoot = ''

  afterEach(async () => {
    repoRoot = ''
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
})
