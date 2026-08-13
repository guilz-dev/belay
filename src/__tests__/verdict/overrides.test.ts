import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { mergeConfig } from '../../core/config.js'
import { classifyShell } from '../../core/verdict/adapter.js'
import { verdictTestContext } from './helpers.js'

describe('config overrides', () => {
  const fixtureRoot = path.join(import.meta.dirname, 'fixtures')

  it('keeps overrides.allow parse-compatible but inert for shell decisions', async () => {
    const baseline = await classifyShell(
      'pnpm release:staging',
      fixtureRoot,
      fixtureRoot,
      mergeConfig({}),
    )
    const config = mergeConfig({ overrides: { allow: ['pnpm release:staging'] } })
    const result = await classifyShell('pnpm release:staging', fixtureRoot, fixtureRoot, config)

    expect(config.overrides.allow).toEqual(['pnpm release:staging'])
    expect(result.verdict).toBe(baseline.verdict)
    expect(result.reason).toBe(baseline.reason)
    expect(result.authorizationDecision).toEqual(baseline.authorizationDecision)
  })

  it('keeps overrides.external parse-compatible but inert for shell decisions', async () => {
    const baseline = await classifyShell('make deploy', fixtureRoot, fixtureRoot, mergeConfig({}))
    const config = mergeConfig({ overrides: { external: ['make deploy'] } })
    const result = await classifyShell('make deploy', fixtureRoot, fixtureRoot, config)

    expect(config.overrides.external).toEqual(['make deploy'])
    expect(result.verdict).toBe(baseline.verdict)
    expect(result.reason).toBe(baseline.reason)
    expect(result.authorizationDecision).toEqual(baseline.authorizationDecision)
  })

  it('does not let legacy classifier option overrides alter shell decisions', async () => {
    const baseline = await classifyShell('make deploy', fixtureRoot, fixtureRoot, mergeConfig({}))
    const result = await classifyShell('make deploy', fixtureRoot, fixtureRoot, mergeConfig({}), {
      customAllowCommands: ['make deploy'],
      customExternalCommands: ['make deploy'],
    })

    expect(result.verdict).toBe(baseline.verdict)
    expect(result.reason).toBe(baseline.reason)
    expect(result.authorizationDecision).toEqual(baseline.authorizationDecision)
  })

  it('does not let inert overrides.allow bypass protected control-plane paths', async () => {
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
    expect(result.reason).toBe('tier1_catastrophic')
  })
})

describe('protected artifact roots', () => {
  it('treats controlPlaneDir as a protected root in verdict context', async () => {
    const controlPlaneDir = '/home/user/.config/agent-belay'
    const ctx = verdictTestContext({
      protectedArtifactRoots: [controlPlaneDir],
    })
    const { verdict } = await import('../../core/verdict/verdict.js')
    const result = await verdict(`tee ${controlPlaneDir}/pending-approvals.json`, ctx)
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('tier1_catastrophic')
  })
})
