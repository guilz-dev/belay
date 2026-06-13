import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { doctorProject } from '../commands/doctor.js'
import { collectHealthSnapshot } from '../commands/health-snapshot.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('doctor skill-only advisory (T21)', () => {
  it('warns when skill is present but hook floor is missing', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-skill-only-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.cursor', 'skills', 'belay'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'skills', 'belay', 'SKILL.md'),
      '---\nname: belay\n---\n',
    )

    const health = await collectHealthSnapshot({ targetDir: repoRoot })
    expect(health.skillInstalled).toBe(true)
    expect(health.floorInstalled).toBe(false)
    expect(health.skillOnly).toBe(true)

    const report = await doctorProject({ targetDir: repoRoot })
    expect(
      report.warnings.some(
        (warning) => warning.includes('Skill-only install detected') && warning.includes('init'),
      ),
    ).toBe(true)
  })
})
