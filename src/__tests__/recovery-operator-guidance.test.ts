import { describe, expect, it } from 'vitest'

import {
  formatRecoveryStateDiagnostic,
  recoveryNotificationConfigured,
  recoveryNotificationSetupWarning,
} from '../core/recovery/operator-guidance.js'
import { DEFAULT_CONFIG_V3, normalizeConfig } from '../core/config.js'

describe('recovery operator guidance', () => {
  it('detects missing notification channels', () => {
    const config = normalizeConfig({ ...DEFAULT_CONFIG_V3 })
    expect(recoveryNotificationConfigured(config)).toBe(false)
    expect(recoveryNotificationSetupWarning()).toContain('notification channel')
  })

  it('formats needs_manual_repair diagnostics', () => {
    expect(formatRecoveryStateDiagnostic('needs_manual_repair')).toContain('manual')
    expect(formatRecoveryStateDiagnostic('applied')).toBeNull()
    expect(formatRecoveryStateDiagnostic('conflict', 'post-state mismatch')).toBe(
      'post-state mismatch',
    )
  })
})
