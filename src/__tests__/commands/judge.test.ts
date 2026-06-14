import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { judgeList, judgeStatus, judgeUse } from '../../commands/judge.js'
import { loadConfigFile } from '../../config-io.js'
import { initProject } from '../../installer.js'

const tempDirs: string[] = []

function mockInteractiveTTY(value: boolean): () => void {
  const previousStdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const previousStdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value })
  return () => {
    if (previousStdin) {
      Object.defineProperty(process.stdin, 'isTTY', previousStdin)
    } else {
      Reflect.deleteProperty(process.stdin, 'isTTY')
    }
    if (previousStdout) {
      Object.defineProperty(process.stdout, 'isTTY', previousStdout)
    } else {
      Reflect.deleteProperty(process.stdout, 'isTTY')
    }
  }
}

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'belay-judge-cmd-'))
  tempDirs.push(tempDir)
  return tempDir
}

describe('belay judge command', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('lists catalog providers', () => {
    const listing = judgeList() as string
    expect(listing).toContain('local')
    expect(listing).toContain('openai')
    expect(listing).toContain('openrouter')
    expect(listing).not.toContain('anthropic')
  })

  it('switches to local without cloud consent', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, judgeProviderId: 'openai', acceptCloudJudge: true })
    await judgeUse({
      targetDir: repoRoot,
      providerId: 'local',
    })
    const config = await loadConfigFile(repoRoot)
    expect(config.judge.providerId).toBe('local')
    expect(config.judge.provider).toBe('ollama')
  })

  it('status reports providerId and credential state', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    const status = (await judgeStatus({ targetDir: repoRoot })) as string
    expect(status).toContain('providerId : local')
    expect(status).toContain('driver     : ollama')
  })

  it('rejects cursor without endpoint on use', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    await expect(
      judgeUse({
        targetDir: repoRoot,
        providerId: 'cursor',
      }),
    ).rejects.toThrow(/requires --endpoint/)
  })

  it('rejects custom without model on use', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    await expect(
      judgeUse({
        targetDir: repoRoot,
        providerId: 'custom',
        endpoint: 'https://proxy.example.com/v1',
      }),
    ).rejects.toThrow(/custom requires --model/)
  })

  it('rejects --accept-cloud in non-interactive mode for cloud providers', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    const restoreTTY = mockInteractiveTTY(false)
    try {
      await expect(
        judgeUse({
          targetDir: repoRoot,
          providerId: 'openai',
          acceptCloud: true,
        }),
      ).rejects.toThrow(/--accept-cloud has no effect/)
    } finally {
      restoreTTY()
    }
  })

  it('writes audit events on provider change', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    await judgeUse({
      targetDir: repoRoot,
      providerId: 'local',
      model: 'gemma4:e2b',
    })
    const config = await loadConfigFile(repoRoot)
    const auditPath = path.join(repoRoot, config.audit.logPath)
    const audit = await readFile(auditPath, 'utf8')
    expect(audit).toContain('judge_provider_changed')
  })
})
