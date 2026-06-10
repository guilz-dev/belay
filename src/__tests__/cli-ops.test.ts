import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadConfigFile } from '../config-io.js'
import { explainCommand } from '../explain.js'
import { initProject, upgradeProject } from '../installer.js'
import { revokeApproval } from '../revoke.js'
import { statusProject } from '../status.js'

const tempDirs: string[] = []

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-ops-'))
  tempDirs.push(tempDir)
  return tempDir
}

describe('v0.2 operational commands', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('explain prints subagent classification details', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const report = await explainCommand({
      targetDir: repoRoot,
      kind: 'subagent',
      command: 'deploy to production after tests pass',
    })
    expect(report.result.verdict).toBe('deny_pending_approval')
  })

  it('explain prints shell classification details', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const report = await explainCommand({
      targetDir: repoRoot,
      command: 'git push origin main',
    })
    expect(report.result.verdict).toBe('deny_pending_approval')
    expect(report.result.assessment.signals.length).toBeGreaterThan(0)
  })

  it('upgrade refreshes runtime while preserving merged config', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.approvalTtlMinutes = 45
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

    await upgradeProject({ targetDir: repoRoot })
    const coreAfter = await readFile(
      path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs'),
      'utf8',
    )
    const merged = await loadConfigFile(repoRoot)

    expect(merged.approvalTtlMinutes).toBe(45)
    expect(merged.version).toBe(3)
    expect(coreAfter.length).toBeGreaterThan(0)
    expect(coreAfter).toContain('RUNTIME_BUILD_STAMP')
    expect(coreAfter).toMatch(/RUNTIME_BUILD_STAMP = "0\.2\.0@/)
    expect(coreAfter).toContain('classifyShell')
  })

  it('status and revoke manage pending approvals', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const pendingPath = path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json')
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          version: 1,
          approvals: [
            {
              approvalId: 'belay_testapproval',
              kind: 'shell',
              fingerprint: 'abc',
              repoRoot,
              reason: 'external_effect',
              summary: 'git push',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const before = await statusProject({ targetDir: repoRoot })
    expect(before.pending).toHaveLength(1)

    const revoked = await revokeApproval({
      targetDir: repoRoot,
      approvalId: 'belay_testapproval',
    })
    expect(revoked.ok).toBe(true)

    const after = await statusProject({ targetDir: repoRoot })
    expect(after.pending).toHaveLength(0)
  })
})
