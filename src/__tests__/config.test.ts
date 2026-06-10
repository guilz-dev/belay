import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG_V2, mergeConfig, migrateConfig } from '../core/config.js'

describe('config migration', () => {
  it('migrates v1 config to v2 with new gate defaults', () => {
    const migrated = migrateConfig({
      version: 1,
      mode: 'audit',
      approvalTtlMinutes: 30,
      tokenPrefix: '/belay-approve',
      gates: { shell: true, subagent: false },
      audit: { logPath: '.cursor/belay/audit.ndjson' },
    })

    expect(migrated.version).toBe(2)
    expect(migrated.mode).toBe('audit')
    expect(migrated.approvalTtlMinutes).toBe(30)
    expect(migrated.gates.subagent).toBe(false)
    expect(migrated.gates.fileMutation).toBe(true)
    expect(migrated.gates.toolShell).toBe(true)
    expect(migrated.classifier.sensitivePaths).toContain('.env')
  })

  it('merges user classifier overrides without dropping defaults', () => {
    const merged = mergeConfig({
      version: 2,
      classifier: {
        customAllowCommands: ['pnpm release:staging'],
      },
    })

    expect(merged.classifier.customAllowCommands).toEqual(['pnpm release:staging'])
    expect(merged.gates.shell).toBe(DEFAULT_CONFIG_V2.gates.shell)
  })
})
