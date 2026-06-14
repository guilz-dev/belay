import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { allPathsAllowlisted, isPathAllowlisted } from '../core/capability/allowlist.js'
import {
  evaluateL1FullStatus,
  isCapabilityBrokerDemotionActive,
  isSandboxBrokerEnabled,
} from '../core/capability/broker.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { classifyShellCore, classifyShellGated } from './helpers/shell-classify.js'

const repoRoot = '/workspace/project'
const outsidePath = path.resolve(repoRoot, '..', 'outside.txt')

describe('capability broker policy', () => {
  it('is enabled only when sandbox.enabled is true', () => {
    expect(
      isSandboxBrokerEnabled({
        ...DEFAULT_CONFIG_V3,
        sandbox: { ...DEFAULT_CONFIG_V3.sandbox, enabled: true },
      }),
    ).toBe(true)
    expect(isSandboxBrokerEnabled(DEFAULT_CONFIG_V3)).toBe(false)
  })

  it('does not demote outside-repo rules when sandbox.runtime is none', async () => {
    expect(
      isCapabilityBrokerDemotionActive({
        ...DEFAULT_CONFIG_V3,
        sandbox: { ...DEFAULT_CONFIG_V3.sandbox, enabled: true, runtime: 'none' },
      }),
    ).toBe(false)

    const result = await classifyShellCore('echo hi > ../outside.txt', repoRoot, repoRoot, {
      brokerFsScope: false,
      unknownLocalEffect: 'deny',
    })
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('outside_repo_mutation')
  })

  it('demotes outside-repo shell denies to capability hints when paths are allowlisted', async () => {
    const result = await classifyShellGated(
      'echo hi > ../outside.txt',
      repoRoot,
      repoRoot,
      DEFAULT_CONFIG_V3,
      {
        brokerFsScope: true,
        fsScopeAllowlist: {
          version: 1,
          paths: [
            { path: outsidePath, approvedAt: '2026-01-01T00:00:00.000Z', approvalId: 'belay_test' },
          ],
        },
        unknownLocalEffect: 'deny',
      },
    )
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('capability_fs_hint')
    expect(result.assessment.signals).toContain('sandbox_boundary_expected')
  })

  it('still denies outside-repo shell when broker is inactive', async () => {
    const result = await classifyShellCore('cp README.md ../copy.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'deny',
    })
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('outside_repo_mutation')
  })

  it('matches allowlisted path prefixes', () => {
    const allowlist = {
      version: 1 as const,
      paths: [
        { path: '/tmp/shared', approvedAt: '2026-01-01T00:00:00.000Z', approvalId: 'belay_test' },
      ],
    }
    expect(isPathAllowlisted('/tmp/shared/nested/file.txt', allowlist)).toBe(true)
    expect(allPathsAllowlisted(['/tmp/shared/nested/file.txt'], allowlist)).toBe(true)
  })

  it('does not treat a child allowlist entry as approval for the parent directory', () => {
    const allowlist = {
      version: 1 as const,
      paths: [
        {
          path: '/tmp/shared/nested/file.txt',
          approvedAt: '2026-01-01T00:00:00.000Z',
          approvalId: 'belay_test',
        },
      ],
    }
    expect(isPathAllowlisted('/tmp/shared', allowlist)).toBe(false)
    expect(isPathAllowlisted('/tmp/shared/nested/file.txt', allowlist)).toBe(true)
  })

  it('requires all full-isolation prerequisites', () => {
    const active = evaluateL1FullStatus({
      config: {
        ...DEFAULT_CONFIG_V3,
        sandbox: { ...DEFAULT_CONFIG_V3.sandbox, enabled: true, runtime: 'container' },
        egress: { ...DEFAULT_CONFIG_V3.egress, enabled: true },
        approvalSigning: { required: true },
        controlPlane: {
          ...DEFAULT_CONFIG_V3.controlPlane,
          isolation: { mode: 'separate-user', verifyAgentWritable: true },
        },
      },
      egressProxyRunning: true,
    })
    expect(active.active).toBe(true)

    const inactive = evaluateL1FullStatus({
      config: {
        ...DEFAULT_CONFIG_V3,
        sandbox: { ...DEFAULT_CONFIG_V3.sandbox, enabled: true, runtime: 'container' },
        egress: { ...DEFAULT_CONFIG_V3.egress, enabled: true },
        approvalSigning: { required: false },
        controlPlane: {
          ...DEFAULT_CONFIG_V3.controlPlane,
          isolation: { mode: 'separate-user', verifyAgentWritable: true },
        },
      },
      egressProxyRunning: true,
    })
    expect(inactive.active).toBe(false)

    const runtimeNone = evaluateL1FullStatus({
      config: {
        ...DEFAULT_CONFIG_V3,
        sandbox: { ...DEFAULT_CONFIG_V3.sandbox, enabled: true, runtime: 'none' },
        egress: { ...DEFAULT_CONFIG_V3.egress, enabled: true },
        approvalSigning: { required: true },
        controlPlane: {
          ...DEFAULT_CONFIG_V3.controlPlane,
          isolation: { mode: 'separate-user', verifyAgentWritable: true },
        },
      },
      egressProxyRunning: true,
    })
    expect(runtimeNone.active).toBe(false)
    expect(runtimeNone.sandbox).toBe(false)
  })
})
