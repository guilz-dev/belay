import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CONFIG_V3,
  defaultControlPlaneDir,
  isFreshConfigInput,
  LEGACY_POLICY_V3,
  mapLegacyClassifierToOverrides,
  mergeConfig,
  migrateConfig,
  migrateV2ToV3,
  normalizeConfig,
  resolveControlPlaneDir,
} from '../core/config.js'

describe('config migration', () => {
  it('migrates v1 config to v3 with new gate and section defaults', () => {
    const migrated = migrateConfig({
      version: 1,
      mode: 'audit',
      approvalTtlMinutes: 30,
      tokenPrefix: '/belay-approve',
      gates: { shell: true, subagent: false },
      audit: { logPath: '.cursor/belay/audit.ndjson' },
    })

    expect(migrated.version).toBe(3)
    expect(migrated.mode).toBe('audit')
    expect(migrated.approvalTtlMinutes).toBe(30)
    expect(migrated.gates.subagent).toBe(false)
    expect(migrated.gates.fileMutation).toBe(true)
    expect(migrated.gates.toolShell).toBe(true)
    expect(migrated.classifier.sensitivePaths).toContain('.env')
    expect(migrated.policy.unknownLocalEffect).toBe(LEGACY_POLICY_V3.unknownLocalEffect)
    expect(migrated.overrides.allow).toEqual([])
    expect(migrated.redaction.maskBearerTokens).toBe(true)
    expect(migrated.controlPlane.enabled).toBe(false)
  })

  it('maps v2 classifier custom* fields to overrides (M1)', () => {
    const migrated = migrateConfig({
      version: 2,
      classifier: {
        customAllowCommands: ['pnpm release:staging'],
        customExternalCommands: ['./scripts/release.sh'],
      },
    })

    expect(migrated.version).toBe(3)
    expect(migrated.overrides.allow).toEqual(['pnpm release:staging'])
    expect(migrated.overrides.external).toEqual(['./scripts/release.sh'])
    expect(migrated.classifier).not.toHaveProperty('customAllowCommands')
    expect(migrated.classifier).not.toHaveProperty('customExternalCommands')
  })

  it('treats version-less v3 sections as v3 config', () => {
    const migrated = migrateConfig({
      controlPlane: { enabled: true, configDir: '/tmp/belay-cp' },
    })

    expect(migrated.version).toBe(3)
    expect(migrated.controlPlane.enabled).toBe(true)
    expect(migrated.controlPlane.configDir).toBe('/tmp/belay-cp')
  })

  it('merges v2 legacy custom* with explicit overrides without duplicates', () => {
    const migrated = migrateConfig({
      version: 2,
      classifier: {
        customAllowCommands: ['pnpm release:staging'],
        customExternalCommands: ['./scripts/release.sh'],
      },
      overrides: {
        allow: ['git push'],
        external: ['curl'],
      },
    })

    expect(migrated.overrides.allow).toEqual(['git push', 'pnpm release:staging'])
    expect(migrated.overrides.external).toEqual(['curl', './scripts/release.sh'])
  })

  it('merges user overrides without dropping defaults', () => {
    const merged = mergeConfig({
      version: 3,
      overrides: {
        allow: ['pnpm release:staging'],
      },
    })

    expect(merged.overrides.allow).toEqual(['pnpm release:staging'])
    expect(merged.gates.shell).toBe(DEFAULT_CONFIG_V3.gates.shell)
    expect(merged.policy.unknownLocalEffect).toBe(LEGACY_POLICY_V3.unknownLocalEffect)
  })

  it('normalizes v3 policy and control plane fields', () => {
    const normalized = normalizeConfig({
      ...DEFAULT_CONFIG_V3,
      policy: {
        ...DEFAULT_CONFIG_V3.policy,
        unknownLocalEffect: 'deny',
        unparseableShell: 'deny',
      },
      controlPlane: { enabled: true, configDir: '  /tmp/belay  ', integrity: 'none' },
    })

    expect(normalized.policy.unknownLocalEffect).toBe('deny')
    expect(normalized.controlPlane.enabled).toBe(true)
    expect(normalized.controlPlane.configDir).toBe('/tmp/belay')
  })

  it('normalizes transactional policy defaults and overrides', () => {
    const defaults = normalizeConfig({ ...DEFAULT_CONFIG_V3 })
    expect(defaults.policy.transactional.enabled).toBe(false)
    expect(defaults.policy.transactional.gates.shell).toBe(true)

    const enabled = normalizeConfig({
      ...DEFAULT_CONFIG_V3,
      policy: {
        ...DEFAULT_CONFIG_V3.policy,
        transactional: {
          enabled: true,
          minConfidence: 0.6,
          maxConfidence: 0.85,
          timeoutMs: 5000,
          maxDeletionCount: 3,
          gates: { shell: false },
        },
      },
    })
    expect(enabled.policy.transactional.enabled).toBe(true)
    expect(enabled.policy.transactional.minConfidence).toBe(0.6)
    expect(enabled.policy.transactional.maxDeletionCount).toBe(3)
    expect(enabled.policy.transactional.gates.shell).toBe(false)
  })

  it('resets invalid transactional confidence bands', () => {
    const normalized = normalizeConfig({
      ...DEFAULT_CONFIG_V3,
      policy: {
        ...DEFAULT_CONFIG_V3.policy,
        transactional: {
          ...DEFAULT_CONFIG_V3.policy.transactional,
          minConfidence: 0.9,
          maxConfidence: 0.8,
        },
      },
    })
    expect(normalized.policy.transactional.minConfidence).toBe(0.72)
    expect(normalized.policy.transactional.maxConfidence).toBe(0.88)
  })

  it('resolves default control plane directory from XDG_CONFIG_HOME', () => {
    expect(defaultControlPlaneDir({ XDG_CONFIG_HOME: '/custom/config' }, () => '/home/user')).toBe(
      '/custom/config/agent-belay',
    )
    expect(defaultControlPlaneDir({}, () => '/home/user')).toBe('/home/user/.config/agent-belay')
  })

  it('resolveControlPlaneDir prefers explicit configDir', () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG_V3,
      controlPlane: { enabled: true, configDir: '/explicit/belay', integrity: 'none' },
    })
    expect(resolveControlPlaneDir(config)).toBe('/explicit/belay')
  })

  it('uses fail-closed defaults for fresh installs', () => {
    expect(isFreshConfigInput({})).toBe(true)
    const merged = mergeConfig({})
    expect(merged.policy.unknownLocalEffect).toBe('deny')
    expect(merged.policy.unparseableShell).toBe('deny')
    expect(merged.controlPlane.enabled).toBe(true)
    expect(merged.controlPlane.integrity).toBe('hash-pinned')
  })

  it('preserves explicit allow_flagged on migrated v3 configs', () => {
    const merged = mergeConfig({
      version: 3,
      policy: { unknownLocalEffect: 'allow_flagged', unparseableShell: 'allow_flagged' },
    })
    expect(merged.policy.unknownLocalEffect).toBe('allow_flagged')
    expect(merged.policy.unparseableShell).toBe('allow_flagged')
  })
})

describe('mapLegacyClassifierToOverrides', () => {
  it('extracts legacy lists', () => {
    expect(
      mapLegacyClassifierToOverrides({
        customAllowCommands: ['a'],
        customExternalCommands: ['b'],
      }),
    ).toEqual({ allow: ['a'], external: ['b'] })
  })
})

describe('migrateV2ToV3', () => {
  it('preserves v2 gate and audit settings', () => {
    const fromV2 = migrateV2ToV3({
      version: 2,
      mode: 'audit',
      approvalTtlMinutes: 15,
      tokenPrefix: '/belay-approve',
      gates: {
        shell: true,
        subagent: true,
        fileMutation: true,
        toolShell: false,
      },
      classifier: {
        strictChains: false,
        customAllowCommands: ['make deploy'],
        customExternalCommands: ['curl'],
        sensitivePaths: ['.env'],
      },
      audit: {
        logPath: 'custom.ndjson',
        includeAssessment: false,
      },
    })

    expect(fromV2.version).toBe(3)
    expect(fromV2.gates.toolShell).toBe(false)
    expect(fromV2.audit.logPath).toBe('custom.ndjson')
    expect(fromV2.classifier.strictChains).toBe(false)
    expect(fromV2.overrides.allow).toEqual(['make deploy'])
    expect(fromV2.overrides.external).toEqual(['curl'])
  })
})
