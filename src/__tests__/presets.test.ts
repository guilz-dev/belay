import { describe, expect, it } from 'vitest'
import { mergeConfig, normalizeConfig } from '../core/config.js'
import { applyConfigPreset, CONFIG_PRESETS } from '../presets.js'

describe('config presets', () => {
  it('exposes l1-full-recommended adversarial stack fields', () => {
    const preset = CONFIG_PRESETS['l1-full-recommended']
    expect(preset.sandbox?.enabled).toBe(true)
    expect(preset.sandbox?.runtime).toBe('container')
    expect(preset.egress?.enabled).toBe(true)
    expect(preset.approvalSigning?.required).toBe(true)
    expect(preset.controlPlane?.isolation?.mode).toBe('separate-user')
  })

  it('merges l1-full-recommended preset into a normalized config', () => {
    const merged = normalizeConfig(mergeConfig(applyConfigPreset('l1-full-recommended')))
    expect(merged.sandbox.enabled).toBe(true)
    expect(merged.sandbox.runtime).toBe('container')
    expect(merged.egress.enabled).toBe(true)
    expect(merged.approvalSigning.required).toBe(true)
    expect(merged.controlPlane.isolation.mode).toBe('separate-user')
    expect(merged.policy.unknownLocalEffect).toBe('allow_flagged')
  })
})
