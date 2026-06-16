import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  mergeAndWriteConfig,
  migrateRepoLocalApprovalsToControlPlane,
  pendingApprovalsPath,
  saveApprovalState,
} from '../config-io.js'
import { mergeConfig } from '../core/config.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('config-io approval state permissions', () => {
  it('writes approval state files with mode 0600', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-approval-perm-'))
    tempDirs.push(repoRoot)
    const config = mergeConfig({ version: 3 })
    await saveApprovalState(
      repoRoot,
      'pending-approvals.json',
      { version: 1, approvals: [] },
      config,
    )
    const filePath = pendingApprovalsPath(repoRoot, config)
    const mode = (await stat(filePath)).mode & 0o777
    expect(mode).toBe(0o600)
  })
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

  it('merges repo-local approvals into existing control-plane files by approvalId', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cp-merge-'))
    tempDirs.push(repoRoot)
    const controlPlaneDir = path.join(repoRoot, 'user-config', 'agent-belay')
    const config = mergeConfig({
      version: 3,
      controlPlane: { enabled: true, configDir: controlPlaneDir },
    })

    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'),
      `${JSON.stringify({
        version: 1,
        approvals: [
          {
            approvalId: 'belay_local',
            kind: 'shell',
            fingerprint: 'local',
            repoRoot,
            reason: 'external_effect',
            summary: 'local push',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        ],
      })}\n`,
    )
    await mkdir(controlPlaneDir, { recursive: true })
    await writeFile(
      path.join(controlPlaneDir, 'pending-approvals.json'),
      `${JSON.stringify({
        version: 1,
        approvals: [
          {
            approvalId: 'belay_cp',
            kind: 'shell',
            fingerprint: 'cp',
            repoRoot,
            reason: 'external_effect',
            summary: 'cp push',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        ],
      })}\n`,
    )

    await migrateRepoLocalApprovalsToControlPlane(repoRoot, config)
    const merged = JSON.parse(
      await readFile(path.join(controlPlaneDir, 'pending-approvals.json'), 'utf8'),
    )

    expect(merged.approvals).toHaveLength(2)
    expect(merged.approvals.map((approval: { approvalId: string }) => approval.approvalId)).toEqual(
      expect.arrayContaining(['belay_cp', 'belay_local']),
    )
  })

  it('migrates control-plane approvals to repo-local when control plane is disabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cp-reverse-'))
    tempDirs.push(repoRoot)
    const controlPlaneDir = path.join(repoRoot, 'user-config', 'agent-belay')
    await initProject({ targetDir: repoRoot })
    await mkdir(controlPlaneDir, { recursive: true })
    await writeFile(
      path.join(controlPlaneDir, 'pending-approvals.json'),
      `${JSON.stringify({
        version: 1,
        approvals: [
          {
            approvalId: 'belay_cp_only',
            kind: 'shell',
            fingerprint: 'cp',
            repoRoot,
            reason: 'external_effect',
            summary: 'cp push',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
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
        controlPlane: { enabled: false, configDir: controlPlaneDir },
      })}\n`,
    )

    await mergeAndWriteConfig(repoRoot)
    const migrated = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'), 'utf8'),
    )
    expect(migrated.approvals).toHaveLength(1)
    expect(migrated.approvals[0].approvalId).toBe('belay_cp_only')
  })

  it('does not re-merge control-plane approvals on upgrade when repo-local files already exist', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cp-skip-'))
    tempDirs.push(repoRoot)
    const controlPlaneDir = path.join(repoRoot, 'user-config', 'agent-belay')
    await initProject({ targetDir: repoRoot })
    await mkdir(controlPlaneDir, { recursive: true })
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await writeFile(
      path.join(controlPlaneDir, 'pending-approvals.json'),
      `${JSON.stringify({
        version: 1,
        approvals: [
          {
            approvalId: 'belay_cp_only',
            kind: 'shell',
            fingerprint: 'cp',
            repoRoot,
            reason: 'external_effect',
            summary: 'cp push',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        ],
      })}\n`,
    )
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'),
      `${JSON.stringify({
        version: 1,
        approvals: [
          {
            approvalId: 'belay_local_only',
            kind: 'shell',
            fingerprint: 'local',
            repoRoot,
            reason: 'external_effect',
            summary: 'local push',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
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
        controlPlane: { enabled: false, configDir: controlPlaneDir },
      })}\n`,
    )

    await mergeAndWriteConfig(repoRoot)
    const repoLocal = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'), 'utf8'),
    )
    expect(repoLocal.approvals).toHaveLength(1)
    expect(repoLocal.approvals[0].approvalId).toBe('belay_local_only')
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
