import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { doctorProject } from '../commands/doctor.js'
import { getManagedHookEntries } from '../defaults.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []
const BUNDLED_SKILL_PATH = new URL('../../skills/belay/SKILL.md', import.meta.url)
const BUNDLED_COMMAND_TEMPLATES = [
  'belay-approve.md',
  'belay-why.md',
  'belay-explain.md',
  'belay-status.md',
  'belay-report.md',
  'belay-recover.md',
] as const

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
    await initProject({ targetDir: repoRoot, withSkill: true })

    const hooksPath = path.join(cursorDir, 'hooks.json')
    const hooks = await readJson(hooksPath)
    const managed = getManagedHookEntries(process.platform)
    const managedByEvent = Object.fromEntries(
      managed.map((entry) => [entry.event, entry.definition]),
    )

    expect(hooks.hooks.beforeSubmitPrompt[0].command).toBe(
      managedByEvent.beforeSubmitPrompt.command,
    )
    expect(hooks.hooks.beforeShellExecution[0].command).toBe(
      managedByEvent.beforeShellExecution.command,
    )
    expect(
      hooks.hooks.preToolUse.map((entry: { matcher?: string }) => entry.matcher).sort(),
    ).toEqual(['Delete', 'Shell', 'StrReplace', 'Task', 'Write'])
    expect(
      hooks.hooks.subagentStart.map((entry: { matcher?: string }) => entry.matcher).sort(),
    ).toEqual(['bugbot', 'computerUse', 'debug', 'explore', 'generalPurpose', 'videoReview'])
    expect(hooks.hooks.postToolUse.at(-1).command).toBe(managedByEvent.postToolUse.command)
    expect(hooks.hooks.stop.at(-1).command).toBe(managedByEvent.stop.command)
    expect(hooks.hooks.sessionEnd.at(-1).command).toBe(managedByEvent.sessionEnd.command)

    const skillPath = path.join(cursorDir, 'skills', 'belay', 'SKILL.md')
    const runnerPath = path.join(cursorDir, 'hooks', 'belay-runner')
    const runnerCmdPath = path.join(cursorDir, 'hooks', 'belay-runner.cmd')
    const configPath = path.join(cursorDir, 'belay.config.json')
    const bundledSkill = await readFile(BUNDLED_SKILL_PATH, 'utf8')
    expect(bundledSkill).toContain('name: belay')
    expect(bundledSkill).toContain('description:')

    expect(await readFile(skillPath, 'utf8')).toBe(bundledSkill)
    for (const fileName of BUNDLED_COMMAND_TEMPLATES) {
      const bundledCommand = await readFile(
        new URL(`../../skills/belay/${fileName}`, import.meta.url),
        'utf8',
      )
      const installedPath = path.join(cursorDir, 'commands', fileName)
      expect(await readFile(installedPath, 'utf8')).toBe(bundledCommand)
    }
    expect(await readFile(runnerPath, 'utf8')).toContain('resolve_node')
    expect(await readFile(runnerCmdPath, 'utf8')).toContain('NODE_BIN')
    expect(await readFile(configPath, 'utf8')).toContain('"mode": "enforce"')
    expect(await readFile(configPath, 'utf8')).toContain('"version": 4')
  })

  it('is idempotent across repeated init runs', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, withSkill: true })
    const hooksPath = path.join(repoRoot, '.cursor', 'hooks.json')
    const first = await readFile(hooksPath, 'utf8')

    await initProject({ targetDir: repoRoot, withSkill: true })
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
    const managed = getManagedHookEntries(process.platform)
    const shellHook = managed.find((entry) => entry.event === 'beforeShellExecution')?.definition
    const postHook = managed.find((entry) => entry.event === 'postToolUse')?.definition
    expect(
      hooks.hooks.beforeShellExecution.map((entry: { command: string }) => entry.command),
    ).toEqual([shellHook?.command, 'python3 existing-shell.py'])
    expect(hooks.hooks.postToolUse.map((entry: { command: string }) => entry.command)).toEqual([
      'python3 existing-post.py',
      postHook?.command,
    ])
  })

  it('writes l1-full-recommended preset fields into belay.config.json', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, preset: 'l1-full-recommended' })

    const config = await readJson(path.join(repoRoot, '.cursor', 'belay.config.json'))
    expect(config.mode).toBe('enforce')
    expect(config.sandbox.enabled).toBe(true)
    expect(config.sandbox.runtime).toBe('container')
    expect(config.egress.enabled).toBe(true)
    expect(config.egress.demoteL3External).toBe(true)
    expect(config.approvalSigning.required).toBe(true)
    expect(config.controlPlane.isolation.mode).toBe('separate-user')
    expect(config.policy.unknownLocalEffect).toBe('allow_flagged')
    expect(config.policy.unparseableShell).toBe('deny')
  })

  it('reports a healthy installation via doctor', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, judgeProfile: 'local-ollama' })

    const report = await doctorProject({ targetDir: repoRoot })
    expect(report.warnings.some((warning) => warning.includes('modelAssist'))).toBe(false)
    expect(report.notes.some((note) => note.includes('Judge provider: ollama'))).toBe(true)
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
