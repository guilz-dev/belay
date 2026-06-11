import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyShell } from '../core/classify-shell.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')

describe('L3 external demotion with egress enabled', () => {
  it('flags external commands instead of denying when demoteL3External is set', () => {
    const result = classifyShell('git push origin main', cwd, repoRoot, {
      egressEnabled: true,
      demoteL3External: true,
    })
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('l3_external_hint')
    expect(result.assessment.signals).toContain('egress_boundary_expected')
  })

  it('still denies external commands when demoteL3External is false', () => {
    const result = classifyShell('git push origin main', cwd, repoRoot, {
      egressEnabled: true,
      demoteL3External: false,
    })
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('external_effect')
  })

  it('demotes python -c style unknown external sends to hints', () => {
    const result = classifyShell(
      'python -c "import urllib.request; urllib.request.urlopen(\'https://example.com\')"',
      cwd,
      repoRoot,
      { egressEnabled: true, demoteL3External: true },
    )
    expect(result.verdict).not.toBe('deny_pending_approval')
  })

  it('demotes npm run deploy scripts to hints', () => {
    const result = classifyShell('npm run deploy:prod', cwd, repoRoot, {
      egressEnabled: true,
      demoteL3External: true,
    })
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('l3_external_hint')
  })
})
