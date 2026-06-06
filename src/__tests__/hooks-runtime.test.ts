import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { initProject } from '../installer.js'

const tempDirs: string[] = []

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-runtime-'))
  tempDirs.push(tempDir)
  return tempDir
}

async function runRunner(
  repoRoot: string,
  hookName: string,
  payload: unknown,
  extraArgs: string[] = [],
) {
  const runnerPath = path.join(repoRoot, '.cursor', 'hooks', 'belay-runner')
  const args = [hookName, ...extraArgs]
  const child = spawn(runnerPath, args, {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  child.stdin.write(JSON.stringify(payload))
  child.stdin.end()

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })

  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8').trim(),
    stderr: Buffer.concat(stderr).toString('utf8').trim(),
  }
}

async function readJson(filePath: string) {
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

describe('generated hook runtime', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('approves exactly one matching denied shell action after /belay-approve', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const denied = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git push origin main',
      cwd: repoRoot,
    })
    const deniedJson = JSON.parse(denied.stdout)
    expect(deniedJson.permission).toBe('deny')
    expect(deniedJson.user_message).toContain('Approval ID: ')

    const pending = await readJson(
      path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'),
    )
    expect(pending.approvals).toHaveLength(1)
    const approvalId = pending.approvals[0].approvalId

    const approvedPrompt = await runRunner(repoRoot, 'belay-before-submit', {
      prompt: `/belay-approve ${approvalId}`,
    })
    const approvedPromptJson = JSON.parse(approvedPrompt.stdout)
    expect(approvedPromptJson.continue).toBe(false)
    expect(approvedPromptJson.user_message).toContain(approvalId)

    const allowed = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git push origin main',
      cwd: repoRoot,
    })
    expect(JSON.parse(allowed.stdout)).toEqual({ permission: 'allow' })

    const deniedAgain = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git push origin main',
      cwd: repoRoot,
    })
    expect(JSON.parse(deniedAgain.stdout).permission).toBe('deny')
  })

  it('allows read-only shell commands and flags local mutations in the audit log', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const readonly = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'rg plan src',
      cwd: repoRoot,
    })
    expect(JSON.parse(readonly.stdout)).toEqual({ permission: 'allow' })

    const flagged = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'touch notes.txt',
      cwd: repoRoot,
    })
    expect(JSON.parse(flagged.stdout)).toEqual({ permission: 'allow' })

    const auditRaw = await readFile(path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson'), 'utf8')
    expect(auditRaw).toContain('"verdict":"allow"')
    expect(auditRaw).toContain('"verdict":"allow_flagged"')
  })

  it('denies relative repo-external shell mutations', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const deniedRedirect = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'echo hi > ../outside.txt',
      cwd: repoRoot,
    })
    expect(JSON.parse(deniedRedirect.stdout).permission).toBe('deny')

    const deniedCopy = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'cp README.md ../copy.txt',
      cwd: repoRoot,
    })
    expect(JSON.parse(deniedCopy.stdout).permission).toBe('deny')
  })

  it('denies high-risk subagent payloads and fingerprints payload changes separately', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const first = await runRunner(
      repoRoot,
      'belay-tool-gate',
      {
        tool_name: 'Task',
        tool_input: {
          description: 'deploy to production after tests pass',
        },
      },
      ['preToolUse'],
    )
    expect(JSON.parse(first.stdout).permission).toBe('deny')

    const second = await runRunner(
      repoRoot,
      'belay-tool-gate',
      {
        tool_name: 'Task',
        tool_input: {
          description: 'deploy to production after smoke tests pass',
        },
      },
      ['preToolUse'],
    )
    expect(JSON.parse(second.stdout).permission).toBe('deny')

    const pending = await readJson(
      path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'),
    )
    expect(pending.approvals).toHaveLength(2)
    expect(pending.approvals[0].fingerprint).not.toBe(pending.approvals[1].fingerprint)
  })
})
