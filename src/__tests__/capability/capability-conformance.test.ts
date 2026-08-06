import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { BOUNDARY_PROFILE_L3_L4_ONLY } from '../../core/capability/boundary-profile.js'
import { CAPABILITY_REQUEST_VERSION } from '../../core/capability/request.js'
import { classifySubagent } from '../../core/classify-subagent.js'
import { classifyToolUse } from '../../core/classify-tool.js'
import { mergeConfig } from '../../core/config.js'
import { classifyGatedAction, normalizeGatedAction } from '../../core/gate-engine.js'
import { classifyShell } from '../../core/verdict/adapter.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')
const config = mergeConfig({})

describe('capability request conformance', () => {
  it('emits CapabilityRequestV1 for shell, tool, and subagent gates', async () => {
    const shell = await classifyShell('curl https://example.com', cwd, repoRoot, config)
    expect(shell.capabilityRequests?.[0]?.version).toBe(CAPABILITY_REQUEST_VERSION)
    expect(shell.capabilityRequests?.[0]?.action).toBe('network.connect')
    expect(shell.authorizationDecision?.outcome).toBe('require_approval')
    expect(shell.boundaryProfile).toBe(BOUNDARY_PROFILE_L3_L4_ONLY)

    const tool = await classifyToolUse(
      {
        tool_name: 'Write',
        tool_input: { path: '../../outside.txt', contents: 'x' },
      },
      repoRoot,
      cwd,
      config,
    )
    expect(tool.capabilityRequests?.[0]?.version).toBe(CAPABILITY_REQUEST_VERSION)
    expect(tool.capabilityRequests?.[0]?.action).toBe('fs.write')
    expect(tool.authorizationDecision?.outcome).toBe('require_approval')
    expect(tool.boundaryProfile).toBe(BOUNDARY_PROFILE_L3_L4_ONLY)

    const subagent = classifySubagent(
      {
        tool_name: 'Task',
        tool_input: { description: 'search auth middleware' },
      },
      repoRoot,
      {},
      config,
    )
    expect(subagent.capabilityRequests?.[0]?.version).toBe(CAPABILITY_REQUEST_VERSION)
    expect(subagent.capabilityRequests?.[0]?.action).toBe('process.exec')
    expect(subagent.authorizationDecision?.outcome).toBe('allow')
    expect(subagent.boundaryProfile).toBe(BOUNDARY_PROFILE_L3_L4_ONLY)
  })

  it('attaches capability metadata on routine in-repo shell allows', async () => {
    const shell = await classifyShell('touch notes.txt', cwd, repoRoot, config)
    expect(shell.verdict).toBe('allow_flagged')
    expect(shell.capabilityRequests?.[0]?.action).toBe('fs.write')
    expect(shell.authorizationDecision?.outcome).toBe('allow')
    expect(shell.boundaryProfile).toBe(BOUNDARY_PROFILE_L3_L4_ONLY)
  })

  it('emits capability metadata through classifyGatedAction', async () => {
    const action = normalizeGatedAction({
      kind: 'shell',
      repoRoot,
      cwd,
      command: 'curl https://example.com',
    })
    const result = await classifyGatedAction(action, config)
    expect(result.capabilityRequests?.[0]?.version).toBe(CAPABILITY_REQUEST_VERSION)
    expect(result.boundaryProfile).toBe(BOUNDARY_PROFILE_L3_L4_ONLY)
  })
})
