import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { classifierOptionsFromConfig, DEFAULT_CONFIG_V3 } from '../core/config.js'
import { classifyShellCore, classifyShellGated } from './helpers/shell-classify.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')

describe('egress external demotion with peripheral policy', () => {
  it('flags external commands instead of denying when demoteL3External is set', async () => {
    const result = await classifyShellGated(
      'git push origin main',
      cwd,
      repoRoot,
      DEFAULT_CONFIG_V3,
      {
        demoteL3External: true,
      },
    )
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('l3_external_hint')
    expect(result.assessment.signals).toContain('egress_boundary_expected')
  })

  it('still denies external commands when demoteL3External is false', async () => {
    const result = await classifyShellCore('git push origin main', cwd, repoRoot, {
      demoteL3External: false,
    })
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('external_effect')
  })

  it('does not demote interpreter opaque paths even when egress demotion is active', async () => {
    const result = await classifyShellGated(
      'python -c "import urllib.request; urllib.request.urlopen(\'https://example.com\')"',
      cwd,
      repoRoot,
      DEFAULT_CONFIG_V3,
      { demoteL3External: true },
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).not.toBe('l3_external_hint')
  })

  it('demotes resolved external launcher recipes to hints', async () => {
    const fixtureRoot = path.join(import.meta.dirname, 'v2', 'fixtures')
    const result = await classifyShellGated(
      'npm run deploy',
      fixtureRoot,
      fixtureRoot,
      DEFAULT_CONFIG_V3,
      {
        demoteL3External: true,
      },
    )
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('l3_external_hint')
  })

  it('does not demote when egress is disabled in config', async () => {
    const options = classifierOptionsFromConfig({
      ...DEFAULT_CONFIG_V3,
      egress: { ...DEFAULT_CONFIG_V3.egress, enabled: false, demoteL3External: true },
    })
    const result = await classifyShellGated(
      'git push origin main',
      cwd,
      repoRoot,
      DEFAULT_CONFIG_V3,
      options,
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('external_effect')
  })

  it('does not demote via classifierOptionsFromConfig until proxy is running', async () => {
    const options = classifierOptionsFromConfig({
      ...DEFAULT_CONFIG_V3,
      egress: { ...DEFAULT_CONFIG_V3.egress, enabled: true, demoteL3External: true },
    })
    expect(options.demoteL3External).toBeUndefined()
    const result = await classifyShellGated(
      'git push origin main',
      cwd,
      repoRoot,
      DEFAULT_CONFIG_V3,
      options,
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('external_effect')
  })
})
