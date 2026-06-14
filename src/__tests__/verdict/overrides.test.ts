import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { mergeConfig } from '../../core/config.js'
import { classifyShell } from '../../core/verdict/adapter.js'
import { v2TestContext } from './helpers.js'

describe('config overrides', () => {
  const fixtureRoot = path.join(import.meta.dirname, 'fixtures')

  it('honors overrides.allow for launcher commands', async () => {
    const config = mergeConfig({ overrides: { allow: ['pnpm release:staging'] } })
    const result = await classifyShell('pnpm release:staging', fixtureRoot, fixtureRoot, config)
    expect(result.verdict).toBe('allow')
    expect(result.reason).toBe('custom_allow')
  })

  it('honors overrides.external before generic unknown classification', async () => {
    const config = mergeConfig({ overrides: { external: ['make deploy'] } })
    const result = await classifyShell('make deploy', fixtureRoot, fixtureRoot, config)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('custom_external')
  })

  it('does not let overrides.allow bypass protected control-plane paths', async () => {
    const controlPlaneDir = '/home/user/.config/agent-belay'
    const config = mergeConfig({
      overrides: { allow: [`tee ${controlPlaneDir}/pending-approvals.json`] },
    })
    const result = await classifyShell(
      `tee ${controlPlaneDir}/pending-approvals.json`,
      fixtureRoot,
      fixtureRoot,
      config,
      { controlPlaneDir },
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('protected_artifact')
  })

  it('prefers custom_allow when a command is listed in both allow and external', async () => {
    const config = mergeConfig({
      overrides: {
        allow: ['git push origin main'],
        external: ['git push origin main'],
      },
    })
    const result = await classifyShell('git push origin main', fixtureRoot, fixtureRoot, config)
    expect(result.verdict).toBe('allow')
    expect(result.reason).toBe('custom_allow')
  })
})

describe('protected artifact roots', () => {
  it('treats controlPlaneDir as a protected root in verdict context', async () => {
    const controlPlaneDir = '/home/user/.config/agent-belay'
    const ctx = v2TestContext({
      protectedArtifactRoots: [controlPlaneDir],
    })
    const { verdict } = await import('../../core/verdict/verdict.js')
    const result = await verdict(`tee ${controlPlaneDir}/pending-approvals.json`, ctx)
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('high_stakes_path')
  })
})
