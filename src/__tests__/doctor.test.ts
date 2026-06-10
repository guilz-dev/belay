import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { doctorProject } from '../doctor.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('doctorProject', () => {
  it('warns when belay.config.json omits version', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const { version: _version, ...withoutVersion } = config
    await writeFile(configPath, `${JSON.stringify(withoutVersion)}\n`)

    const report = await doctorProject({ targetDir: repoRoot })
    expect(report.warnings.some((warning) => warning.includes('missing "version"'))).toBe(true)
  })
})
