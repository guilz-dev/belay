import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyToolUse } from '../core/classify-tool.js'
import { mergeConfig } from '../core/config.js'
import { classifyShell } from '../core/verdict/adapter.js'
import { createDeterministicJudgeStub } from '../core/verdict/judge.js'

const repoRoot = '/workspace/project'
const cwd = repoRoot
const config = mergeConfig({})
const benignJudge = createDeterministicJudgeStub()
const catastrophicJudge = {
  evaluate: () =>
    Promise.resolve({
      local_recoverable: false,
      destroys_outside_repo: false,
      destroys_history_or_secrets: false,
      reason: 'persistent_harm',
    }),
}

describe('classifyToolUse', () => {
  it('reuses v2 shell classification and fingerprint for Shell tool', async () => {
    const shellOnly = await classifyToolUse(
      { tool_name: 'Shell', tool_input: { command: 'git push origin main' } },
      repoRoot,
      cwd,
      config,
    )
    expect(shellOnly.verdict).toBe('deny_pending_approval')
    expect(shellOnly.summary).toBe('git push origin main')
    expect(shellOnly.axes).toBeDefined()

    const shellCore = await classifyShell('git push origin main', cwd, repoRoot, config)
    expect(shellOnly.fingerprint).toBe(shellCore.fingerprint)
  })

  it('allows benign writes outside the repository via Tier1', async () => {
    const result = await classifyToolUse(
      { tool_name: 'Write', tool_input: { path: '/tmp/outside.txt', contents: 'x' } },
      repoRoot,
      cwd,
      config,
      { tier1Judge: benignJudge },
    )
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('file_mutation')
    expect(result.assessment.external).toBe(true)
  })

  it('allows Cursor plan document writes outside the repository', async () => {
    const home = process.env.HOME ?? '/home/user'
    const result = await classifyToolUse(
      {
        tool_name: 'Write',
        tool_input: { path: path.join(home, '.cursor/plans/foo.plan.md'), contents: '# plan' },
      },
      repoRoot,
      cwd,
      config,
      { tier1Judge: benignJudge },
    )
    expect(result.verdict).toBe('allow_flagged')
    expect(result.assessment.signals).toContain('tier1_restorable')
  })

  it('asks on sensitive path mutations when Tier1 says not local-recoverable', async () => {
    const result = await classifyToolUse(
      { tool_name: 'Write', tool_input: { path: '.env', contents: 'SECRET=1' } },
      repoRoot,
      cwd,
      config,
      { tier1Judge: catastrophicJudge },
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('tier1_catastrophic')
  })

  it('asks on sensitive path writes via structural prescan before Tier1', async () => {
    const result = await classifyToolUse(
      { tool_name: 'Write', tool_input: { path: '.env', contents: 'SECRET=1' } },
      repoRoot,
      cwd,
      config,
      { tier1Judge: benignJudge },
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('tier1_catastrophic')
    expect(result.assessment.signals).toContain('sensitive_path_mutation')
  })

  it('asks on ~/.ssh/authorized_keys via structural prescan before Tier1', async () => {
    const home = process.env.HOME ?? '/home/user'
    const result = await classifyToolUse(
      {
        tool_name: 'Write',
        tool_input: { path: path.join(home, '.ssh/authorized_keys'), contents: 'key' },
      },
      repoRoot,
      cwd,
      config,
      { tier1Judge: benignJudge },
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('tier1_catastrophic')
    expect(result.assessment.signals).toContain('persistent_agent_path')
  })

  it('asks on ~/.ssh/authorized_keys when Tier1 says not local-recoverable', async () => {
    const home = process.env.HOME ?? '/home/user'
    const result = await classifyToolUse(
      {
        tool_name: 'Write',
        tool_input: { path: path.join(home, '.ssh/authorized_keys'), contents: 'key' },
      },
      repoRoot,
      cwd,
      config,
      { tier1Judge: catastrophicJudge },
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('tier1_catastrophic')
  })

  it('asks on outside-repo credential writes via structural prescan before Tier1', async () => {
    const home = process.env.HOME ?? '/home/user'
    const result = await classifyToolUse(
      {
        tool_name: 'Write',
        tool_input: { path: path.join(home, '.npmrc'), contents: 'registry=https://example.com' },
      },
      repoRoot,
      cwd,
      config,
      { tier1Judge: benignJudge },
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('tier1_catastrophic')
    expect(result.assessment.signals).toContain('outside_repo_secret_credential_path')
  })

  it('flags routine in-repo file writes', async () => {
    const filePath = path.join(repoRoot, 'notes.txt')
    const result = await classifyToolUse(
      { tool_name: 'Write', tool_input: { path: filePath, contents: 'hello' } },
      repoRoot,
      cwd,
      config,
    )
    expect(result.verdict).toBe('allow_flagged')
  })

  it('treats Edit as an in-repo mutation tool', async () => {
    const result = await classifyToolUse(
      { tool_name: 'Edit', tool_input: { path: path.join(repoRoot, 'notes.txt') } },
      repoRoot,
      cwd,
      config,
    )
    expect(result.verdict).toBe('allow_flagged')
  })

  it('classifies apply_patch against the paths it touches', async () => {
    const result = await classifyToolUse(
      {
        tool_name: 'ApplyPatch',
        tool_input: {
          patch: [
            '*** Begin Patch',
            '*** Update File: notes.txt',
            '@@',
            '+hello',
            '*** End Patch',
          ].join('\n'),
        },
      },
      repoRoot,
      cwd,
      config,
      { tier1Judge: benignJudge },
    )
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('file_mutation')
  })

  it('asks apply_patch when Tier1 flags sensitive paths', async () => {
    const result = await classifyToolUse(
      {
        tool_name: 'ApplyPatch',
        tool_input: {
          patch: [
            '*** Begin Patch',
            '*** Update File: .env',
            '@@',
            '+SECRET=1',
            '*** End Patch',
          ].join('\n'),
        },
      },
      repoRoot,
      cwd,
      config,
      { tier1Judge: catastrophicJudge },
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('tier1_catastrophic')
  })

  it('asks apply_patch moves into sensitive paths when Tier1 flags risk', async () => {
    const result = await classifyToolUse(
      {
        tool_name: 'ApplyPatch',
        tool_input: {
          patch: [
            '*** Begin Patch',
            '*** Update File: notes.txt',
            '*** Move to: .env',
            '@@',
            '+SECRET=1',
            '*** End Patch',
          ].join('\n'),
        },
      },
      repoRoot,
      cwd,
      config,
      { tier1Judge: catastrophicJudge },
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('tier1_catastrophic')
  })

  it('denies writes to the control plane directory (R8)', async () => {
    const controlPlaneDir = '/home/user/.config/agent-belay'
    const result = await classifyToolUse(
      {
        tool_name: 'Write',
        tool_input: {
          path: path.join(controlPlaneDir, 'pending-approvals.json'),
          contents: '{}',
        },
      },
      repoRoot,
      cwd,
      config,
      { controlPlaneDir },
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('control_plane_mutation')
  })
})
