import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyToolUse } from '../core/classify-tool.js'
import { mergeConfig } from '../core/config.js'
import { classifyShellV2 } from '../core/v2/adapter.js'

const repoRoot = '/workspace/project'
const cwd = repoRoot
const config = mergeConfig({})

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
    expect(shellOnly.v2).toBeDefined()

    const shellV2 = await classifyShellV2('git push origin main', cwd, repoRoot, config)
    expect(shellOnly.fingerprint).toBe(shellV2.fingerprint)
  })

  it('denies writes outside the repository', async () => {
    const result = await classifyToolUse(
      { tool_name: 'Write', tool_input: { path: '/tmp/outside.txt', contents: 'x' } },
      repoRoot,
      cwd,
      config,
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('outside_repo_file_mutation')
  })

  it('denies sensitive path mutations', async () => {
    const result = await classifyToolUse(
      { tool_name: 'Write', tool_input: { path: '.env', contents: 'SECRET=1' } },
      repoRoot,
      cwd,
      config,
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('sensitive_file_mutation')
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
