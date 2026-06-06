import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { getManagedHookEvents } from '../defaults.js'
import { doctorProject } from '../doctor.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-'))
  tempDirs.push(tempDir)
  return tempDir
}

async function readJson(filePath: string) {
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

describe('agent-belay installer', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('creates managed hooks and preserves existing ordering around prepend/append hooks', async () => {
    const repoRoot = await createTempRepo()
    const cursorDir = path.join(repoRoot, '.cursor')
    await initProject({ targetDir: repoRoot, nightly: true })

    const hooksPath = path.join(cursorDir, 'hooks.json')
    const hooks = await readJson(hooksPath)
    const managed = getManagedHookEvents(process.platform)

    expect(hooks.hooks.beforeSubmitPrompt[0].command).toBe(managed.beforeSubmitPrompt.command)
    expect(hooks.hooks.beforeShellExecution[0].command).toBe(managed.beforeShellExecution.command)
    expect(hooks.hooks.preToolUse[0]).toEqual({
      command: managed.preToolUse.command,
      matcher: 'Task',
    })
    expect(hooks.hooks.subagentStart[0]).toEqual({
      command: managed.subagentStart.command,
      matcher: 'generalPurpose',
    })
    expect(hooks.hooks.postToolUse.at(-1).command).toBe(managed.postToolUse.command)
    expect(hooks.hooks.stop.at(-1).command).toBe(managed.stop.command)
    expect(hooks.hooks.sessionEnd.at(-1).command).toBe(managed.sessionEnd.command)

    const skillPath = path.join(cursorDir, 'skills', 'belay', 'SKILL.md')
    const commandPath = path.join(cursorDir, 'commands', 'belay-approve.md')
    const runnerPath = path.join(cursorDir, 'hooks', 'belay-runner')
    const runnerCmdPath = path.join(cursorDir, 'hooks', 'belay-runner.cmd')
    const configPath = path.join(cursorDir, 'belay.config.json')

    expect(await readFile(skillPath, 'utf8')).toContain('/belay-approve')
    expect(await readFile(commandPath, 'utf8')).toContain('/belay-approve')
    expect(await readFile(runnerPath, 'utf8')).toContain('resolve_node')
    expect(await readFile(runnerCmdPath, 'utf8')).toContain('NODE_BIN')
    expect(await readFile(configPath, 'utf8')).toContain('"mode": "enforce"')
  })

  it('is idempotent across repeated init runs', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, nightly: true })
    const hooksPath = path.join(repoRoot, '.cursor', 'hooks.json')
    const first = await readFile(hooksPath, 'utf8')

    await initProject({ targetDir: repoRoot, nightly: true })
    const second = await readFile(hooksPath, 'utf8')

    expect(second).toBe(first)
  })

  it('preserves existing hook ordering around prepend and append merges', async () => {
    const repoRoot = await createTempRepo()
    const cursorDir = path.join(repoRoot, '.cursor')
    await mkdir(cursorDir, { recursive: true })
    await writeFile(
      path.join(cursorDir, 'hooks.json'),
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            beforeShellExecution: [{ command: 'python3 existing-shell.py' }],
            postToolUse: [{ command: 'python3 existing-post.py' }],
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    await initProject({ targetDir: repoRoot })

    const hooks = await readJson(path.join(cursorDir, 'hooks.json'))
    const managed = getManagedHookEvents(process.platform)
    expect(
      hooks.hooks.beforeShellExecution.map((entry: { command: string }) => entry.command),
    ).toEqual([managed.beforeShellExecution.command, 'python3 existing-shell.py'])
    expect(hooks.hooks.postToolUse.map((entry: { command: string }) => entry.command)).toEqual([
      'python3 existing-post.py',
      managed.postToolUse.command,
    ])
  })

  it('reports a healthy installation via doctor', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const report = await doctorProject({ targetDir: repoRoot })
    expect(report.ok).toBe(true)
    expect(report.issues).toEqual([])
  })

  it('fails before writing files when hooks.json is malformed', async () => {
    const repoRoot = await createTempRepo()
    const cursorDir = path.join(repoRoot, '.cursor')
    await mkdir(cursorDir, { recursive: true })
    await writeFile(path.join(cursorDir, 'hooks.json'), '{ invalid json\n', 'utf8')

    await expect(initProject({ targetDir: repoRoot })).rejects.toThrow('Invalid hooks.json')
    await expect(readFile(path.join(cursorDir, 'belay.config.json'), 'utf8')).rejects.toThrow()
  })
})
