import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { claudeAdapter } from '../../adapters/claude/adapter.js'
import { gateVerdictToClaudeUserPromptResponse } from '../../adapters/shared/gate-runtime.js'
import { loadConfigFile, pendingApprovalsPath } from '../../config-io.js'

async function runClaudeRunner(
  repoRoot: string,
  hookName: string,
  payload: unknown,
  cwd = repoRoot,
) {
  const runnerPath = path.join(repoRoot, '.claude', 'hooks', 'belay-runner')
  const child = spawn(runnerPath, [hookName], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
  child.stdin.write(JSON.stringify(payload))
  child.stdin.end()
  const exitCode: number = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8').trim(),
  }
}

describe('claude adapter', () => {
  it('UserPromptSubmit: blocked approval uses the native block decision', () => {
    expect(
      gateVerdictToClaudeUserPromptResponse({
        continue: false,
        user_message: 'Pending approval was not found.',
      }),
    ).toEqual({
      decision: 'block',
      reason: 'Pending approval was not found.',
    })
  })

  it('UserPromptSubmit: continued approval reports completed replay as model context', () => {
    expect(
      gateVerdictToClaudeUserPromptResponse({
        continue: true,
        user_message: 'One-step shell replay succeeded; no manual retry required.',
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'One-step shell replay succeeded; no manual retry required.',
      },
    })
  })

  it('UserPromptSubmit: runtime errors fail closed with the native block decision', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-claude-adapter-'))
    try {
      await mkdir(path.join(repoRoot, '.git'))
      await claudeAdapter.install(repoRoot, {})
      const config = await loadConfigFile(repoRoot, 'claude')
      const pendingPath = pendingApprovalsPath(repoRoot, config)
      await rm(pendingPath, { force: true })
      await mkdir(pendingPath)

      const result = await runClaudeRunner(repoRoot, 'belay-before-submit', {
        prompt: '/belay-approve belay_missing',
      })

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        decision: 'block',
        reason: 'belay failed while processing approval state. Run belay doctor, then retry.',
      })
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})
