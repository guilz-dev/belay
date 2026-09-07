import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { simulateProject } from '../commands/simulate.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

describe('simulate', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('reports verdict changes for candidate config', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-sim-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const auditPath = path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson')
    await mkdir(path.dirname(auditPath), { recursive: true })
    await writeFile(
      auditPath,
      `${JSON.stringify({
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
        reason: 'tier1_restorable',
        summary: 'make deploy',
        fingerprint: 'fp-deploy',
        command: 'make deploy',
      })}\n`,
      'utf8',
    )

    const candidatePath = path.join(repoRoot, 'candidate.config.json')
    await writeFile(
      candidatePath,
      `${JSON.stringify({
        version: 3,
        overrides: { external: ['make deploy'] },
      })}\n`,
      'utf8',
    )

    const report = await simulateProject({
      targetDir: repoRoot,
      configPath: candidatePath,
    })

    expect(report.changedCount).toBeGreaterThanOrEqual(1)
    expect(report.allowToDenyCount + report.denyToAllowCount).toBeGreaterThan(0)
    expect(report.missingSnapshotCount).toBe(1)
  })

  it('replays retained v1 and v2 action snapshots across generations', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-sim-generations-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const auditPath = path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson')
    const baseRecord = {
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      reason: 'unknown_local_effect',
      summary: 'git status --short',
    }
    await writeFile(
      `${auditPath}.1`,
      `${JSON.stringify({
        ...baseRecord,
        timestamp: '2026-09-08T00:00:00.000Z',
        fingerprint: 'legacy-v1',
        actionSnapshot: {
          schemaVersion: 1,
          kind: 'shell',
          cwd: repoRoot,
          normalizedAction: 'git status --short',
        },
      })}\n`,
      'utf8',
    )
    await writeFile(
      auditPath,
      `${JSON.stringify({
        ...baseRecord,
        timestamp: '2026-09-08T00:00:01.000Z',
        fingerprint: 'compact-v2',
        actionSnapshot: {
          schemaVersion: 2,
          kind: 'shell',
          cwd: repoRoot,
          normalizedAction: 'git status --short',
        },
      })}\n`,
      'utf8',
    )
    const candidatePath = path.join(repoRoot, 'candidate.config.json')
    await writeFile(candidatePath, '{"version":4}\n', 'utf8')

    const report = await simulateProject({ targetDir: repoRoot, configPath: candidatePath })

    expect(report.totalRecords).toBe(2)
    expect(report.missingSnapshotCount).toBe(0)
    expect(report.changedCount).toBe(2)
    expect(report.diffs.map((diff) => diff.fingerprint)).toEqual(['legacy-v1', 'compact-v2'])
    expect(report.diffs.every((diff) => diff.replayKind === 'shell')).toBe(true)
  })
})
