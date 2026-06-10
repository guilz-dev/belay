import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  mergeAndWriteConfig,
  migrateRepoLocalApprovalsToControlPlane,
  pendingApprovalsPath,
} from '../config-io.js'
import { mergeConfig } from '../core/config.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('config-io control plane migration', () => {
  it('copies repo-local approval files when control plane is newly enabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cp-migrate-'))
    tempDirs.push(repoRoot)
    const controlPlaneDir = path.join(repoRoot, 'user-config', 'agent-belay')

    await initProject({ targetDir: repoRoot })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'),
      `${JSON.stringify({
        version: 1,
        approvals: [
          {
            approvalId: 'belay_test123',
            kind: 'shell',
            fingerprint: 'abc',
            repoRoot,
            reason: 'external_effect',
            summary: 'git push',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-01-01T00:15:00.000Z',
          },
        ],
      })}\n`,
    )

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const existing = JSON.parse(await readFile(configPath, 'utf8'))
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...existing,
        version: 3,
        controlPlane: { enabled: true, configDir: controlPlaneDir },
      })}\n`,
    )

    const merged = await mergeAndWriteConfig(repoRoot)
    const migrated = JSON.parse(
      await readFile(path.join(controlPlaneDir, 'pending-approvals.json'), 'utf8'),
    )

    expect(merged.controlPlane.enabled).toBe(true)
    expect(migrated.approvals).toHaveLength(1)
    expect(migrated.approvals[0].approvalId).toBe('belay_test123')
    expect(pendingApprovalsPath(repoRoot, merged)).toBe(
      path.join(controlPlaneDir, 'pending-approvals.json'),
    )
  })

  it('migrateRepoLocalApprovalsToControlPlane is a no-op when control plane is disabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cp-noop-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    const config = mergeConfig({ version: 3 })
    await migrateRepoLocalApprovalsToControlPlane(repoRoot, config)
    expect(config.controlPlane.enabled).toBe(false)
  })
})
