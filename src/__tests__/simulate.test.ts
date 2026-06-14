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
  })
})
