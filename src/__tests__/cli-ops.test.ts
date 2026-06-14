import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { explainCommand } from '../commands/explain.js'
import { revokeApproval } from '../commands/revoke.js'
import { statusProject } from '../commands/status.js'
import { loadConfigFile, pendingApprovalsPath } from '../config-io.js'
import { initProject, upgradeProject } from '../installer.js'
import { PACKAGE_VERSION } from '../version.js'

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
    expect(report.result.verdict).toBe('allow_flagged')
    expect(report.result.assessment.signals).toContain('subagent_external_intent_hint')
  })

  it('explain respects --kind for tool classification', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const report = await explainCommand({
      targetDir: repoRoot,
      kind: 'tool',
      toolName: 'Write',
      command: '/etc/passwd',
    })
    expect(report.kind).toBe('tool')
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
    expect(report.permission).toBe('ask')
    expect(report.tier).toBeTruthy()
  })

  it('T22: explain --command outputs verdict axes via formatExplainReport', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const { formatExplainReport } = await import('../commands/explain.js')
    const report = await explainCommand({
      targetDir: repoRoot,
      command: 'git push origin main',
    })
    const formatted = formatExplainReport(report)
    expect(formatted).toContain('Permission:')
    expect(formatted).toContain('Reason:')
    expect(formatted).toContain('location:')
    expect(formatted).toContain('effect:')
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
    expect(merged.version).toBe(4)
    expect(coreAfter.length).toBeGreaterThan(0)
    expect(coreAfter).toContain('RUNTIME_BUILD_STAMP')
    expect(coreAfter).toMatch(
      new RegExp(`RUNTIME_BUILD_STAMP = "${PACKAGE_VERSION.replace(/\./g, '\\.')}@`),
    )
    expect(coreAfter).toContain('verdict')
  })

  it('status and revoke manage pending approvals', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const config = await loadConfigFile(repoRoot)
    const pendingPath = pendingApprovalsPath(repoRoot, config)
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
