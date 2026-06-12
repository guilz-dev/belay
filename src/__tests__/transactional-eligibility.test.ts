import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_V3, normalizeConfig } from '../core/config.js'
import { isTransactionalEligible } from '../core/transactional/eligibility.js'
import { classifyShellCore } from './helpers/shell-classify.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')

function configWithTransactional(enabled: boolean) {
  return normalizeConfig({
    ...DEFAULT_CONFIG_V3,
    policy: {
      ...DEFAULT_CONFIG_V3.policy,
      unknownLocalEffect: 'allow_flagged',
      transactional: {
        ...DEFAULT_CONFIG_V3.policy.transactional,
        enabled,
      },
    },
  })
}

describe('transactional eligibility', () => {
  it('is eligible for low-confidence local mutations when enabled', async () => {
    const config = configWithTransactional(true)
    const result = await classifyShellCore('touch notes.txt', cwd, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    expect(result.verdict).toBe('allow_flagged')
    expect(isTransactionalEligible(config, 'shell', result)).toBe(true)
  })

  it('is not eligible when transactional is disabled', async () => {
    const config = configWithTransactional(false)
    const result = await classifyShellCore('touch notes.txt', cwd, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    expect(isTransactionalEligible(config, 'shell', result)).toBe(false)
  })

  it('is not eligible for external commands', async () => {
    const config = configWithTransactional(true)
    const result = await classifyShellCore('git push origin main', cwd, repoRoot)
    expect(isTransactionalEligible(config, 'shell', result)).toBe(false)
  })

  it('is not eligible for high-confidence allow', async () => {
    const config = configWithTransactional(true)
    const result = await classifyShellCore('rg plan src', cwd, repoRoot)
    expect(result.verdict).toBe('allow')
    expect(isTransactionalEligible(config, 'shell', result)).toBe(false)
  })

  it('is not eligible for predicted deny', async () => {
    const config = configWithTransactional(true)
    const result = await classifyShellCore('git push origin main', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(isTransactionalEligible(config, 'shell', result)).toBe(false)
  })

  it('is not eligible when shell gate is disabled', async () => {
    const config = normalizeConfig({
      ...configWithTransactional(true),
      gates: { ...configWithTransactional(true).gates, shell: false },
    })
    const result = await classifyShellCore('touch notes.txt', cwd, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    expect(isTransactionalEligible(config, 'shell', result)).toBe(false)
  })
})
