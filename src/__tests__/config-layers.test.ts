import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { resolveLayeredConfig } from '../core/config-layers.js'

describe('config layers', () => {
  it('merges team config before repo config', () => {
    const result = resolveLayeredConfig({
      repoConfig: { mode: 'enforce', approvalTtlMinutes: 30 },
      adapterDefaults: { ...DEFAULT_CONFIG_V3, mode: 'audit' },
      teamConfig: { config: { mode: 'audit', policy: { unknownLocalEffect: 'deny' } } },
      teamConfigPath: '/home/user/.config/agent-belay/team.config.json',
      repoConfigPath: '/repo/.cursor/belay.config.json',
    })

    expect(result.config.mode).toBe('enforce')
    expect(result.config.approvalTtlMinutes).toBe(30)
    expect(result.config.policy.unknownLocalEffect).toBe('deny')
    expect(result.provenance.some((entry) => entry.source === 'team')).toBe(true)
    expect(result.provenance.some((entry) => entry.source === 'repo')).toBe(true)
  })

  it('prevents disabling control plane from team config', () => {
    const result = resolveLayeredConfig({
      repoConfig: {},
      adapterDefaults: DEFAULT_CONFIG_V3,
      teamConfig: { config: { controlPlane: { enabled: false } } },
      teamConfigPath: '/home/user/.config/agent-belay/team.config.json',
    })

    expect(result.config.controlPlane.enabled).toBe(true)
    expect(result.provenance.some((entry) => entry.source === 'protected')).toBe(true)
  })

  it('prevents weakening protected integrity from none to hash-pinned default', () => {
    const result = resolveLayeredConfig({
      repoConfig: { controlPlane: { integrity: 'none' } },
      adapterDefaults: DEFAULT_CONFIG_V3,
      repoConfigPath: '/repo/.cursor/belay.config.json',
    })

    expect(result.config.controlPlane.integrity).toBe('hash-pinned')
    expect(result.provenance.some((entry) => entry.source === 'protected')).toBe(true)
  })
})
