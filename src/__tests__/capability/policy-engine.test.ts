import { describe, expect, it } from 'vitest'
import type { CapabilityGrantV1 } from '../../core/capability/grant.js'
import {
  buildFileMutationCapabilityRequest,
  buildShellCapabilityRequest,
  createTypeScriptPolicyEngine,
  evaluateFileMutationPolicy,
  evaluateShellPolicy,
} from '../../core/capability/policy-engine.js'
import { mergeConfig } from '../../core/config.js'

const config = mergeConfig({})
const repoRoot = '/workspace/project'

describe('TypeScript PolicyEngine', () => {
  const engine = createTypeScriptPolicyEngine()

  it('allows routine in-repo file writes', () => {
    const request = buildFileMutationCapabilityRequest({
      hookKind: 'tool',
      toolKind: 'write',
      filePath: 'notes.txt',
      resolvedPath: `${repoRoot}/notes.txt`,
      repoRoot,
      cwd: repoRoot,
      inputFingerprint: 'fp-notes',
      signals: ['file_mutation'],
      isDelete: false,
      locationLabel: 'repo_local',
    })
    const decision = engine.evaluate(request, { config, attestation: null })
    expect(decision.outcome).toBe('allow')
    expect(decision.matchedRule).toBe('builtin.repo_local')
  })

  it('requires approval for outside-repo writes', () => {
    const { decision } = evaluateFileMutationPolicy(
      {
        hookKind: 'tool',
        toolKind: 'write',
        filePath: '/tmp/outside.txt',
        resolvedPath: '/tmp/outside.txt',
        repoRoot,
        cwd: repoRoot,
        inputFingerprint: 'fp-outside',
        signals: ['outside_repo_path'],
        isDelete: false,
        locationLabel: 'outside_repo',
      },
      config,
    )
    expect(decision.outcome).toBe('require_approval')
    expect(decision.reason).toBe('outside_repo_mutation')
  })

  it('requires approval for network connect on external shell commands', () => {
    const { request, decision } = evaluateShellPolicy(
      {
        command: 'curl https://example.com',
        hookKind: 'shell',
        segmentHead: 'curl',
        effect: 'remote_mutation',
        location: 'external',
        opacity: 'transparent',
        egressClass: 'read',
        pathArgs: [],
        signals: ['external_effect'],
        cwd: repoRoot,
        repoRoot,
        inputFingerprint: 'fp-curl',
      },
      config,
    )
    expect(request.resource).toEqual({
      kind: 'network',
      host: 'example.com',
      protocol: 'https',
    })
    expect(decision.outcome).toBe('require_approval')
    expect(decision.matchedRule).toBe('builtin.network')
  })

  it('emits one exact capability request for each explicit network host', () => {
    const { requests, decision } = evaluateShellPolicy(
      {
        command: 'curl https://a.example/data https://b.example/data',
        hookKind: 'shell',
        segmentHead: 'curl',
        effect: 'remote_mutation',
        location: 'external',
        opacity: 'transparent',
        egressClass: 'read',
        pathArgs: [],
        signals: ['external_effect'],
        cwd: repoRoot,
        repoRoot,
        inputFingerprint: 'fp-curl-multi',
      },
      config,
    )

    expect(requests.map((request) => request.resource)).toEqual([
      { kind: 'network', host: 'a.example', protocol: 'https' },
      { kind: 'network', host: 'b.example', protocol: 'https' },
    ])
    expect(decision.outcome).toBe('require_approval')
  })

  it('denies matching forged broad grants', () => {
    const request = buildShellCapabilityRequest({
      command: 'curl https://example.com',
      hookKind: 'shell',
      segmentHead: 'curl',
      effect: 'remote_mutation',
      location: 'external',
      opacity: 'transparent',
      egressClass: 'read',
      pathArgs: [],
      signals: [],
      cwd: repoRoot,
      repoRoot,
      inputFingerprint: 'fp-curl',
    })
    const broadGrant: CapabilityGrantV1 = {
      version: 1,
      grantId: 'g1',
      principal: { repoRoot },
      action: 'network.connect',
      resource: { kind: 'unknown' },
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxUses: 1,
      usesRemaining: 1,
      issuer: 'test',
    }
    const decision = engine.evaluate(request, { config, grants: [broadGrant], attestation: null })
    expect(decision.outcome).toBe('deny')
    expect(decision.reason).toBe('grant_scope_too_broad')
  })

  it('ignores broad grants that do not match the request', () => {
    const request = buildShellCapabilityRequest({
      command: 'touch notes.txt',
      hookKind: 'shell',
      segmentHead: 'touch',
      effect: 'local_mutation',
      location: 'repo_local',
      opacity: 'transparent',
      pathArgs: [`${repoRoot}/notes.txt`],
      signals: [],
      cwd: repoRoot,
      repoRoot,
      inputFingerprint: 'fp-touch',
    })
    const broadGrant: CapabilityGrantV1 = {
      version: 1,
      grantId: 'g-broad',
      principal: { repoRoot },
      action: 'network.connect',
      resource: { kind: 'unknown' },
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxUses: 1,
      usesRemaining: 1,
      issuer: 'test',
    }
    const decision = engine.evaluate(request, { config, grants: [broadGrant], attestation: null })
    expect(decision.outcome).not.toBe('deny')
    expect(decision.reason).not.toBe('grant_scope_too_broad')
  })

  it('requires approval for sensitive path writes via fs.write', () => {
    const { decision } = evaluateFileMutationPolicy(
      {
        hookKind: 'tool',
        toolKind: 'write',
        filePath: '.env',
        resolvedPath: `${repoRoot}/.env`,
        repoRoot,
        cwd: repoRoot,
        inputFingerprint: 'fp-env',
        signals: ['sensitive_path'],
        isDelete: false,
        locationLabel: 'sensitive_path',
        sensitivePaths: ['.env'],
      },
      config,
    )
    expect(decision.outcome).toBe('require_approval')
    expect(decision.matchedRule).toBe('builtin.sensitive_path')
  })

  it('does not widen via boundary.verified for outside repo even with materializing attestation', () => {
    const request = buildShellCapabilityRequest({
      command: 'touch /tmp/outside.txt',
      hookKind: 'shell',
      segmentHead: 'touch',
      effect: 'local_mutation',
      location: 'repo_outside',
      opacity: 'transparent',
      pathArgs: ['/tmp/outside.txt'],
      resolvedPathTargets: ['/tmp/outside.txt'],
      signals: ['outside_repo_path'],
      cwd: repoRoot,
      repoRoot,
      inputFingerprint: 'fp-outside-verified',
    })
    request.evidence.level = 'certain'
    const freshAttestation = {
      version: 1 as const,
      driver: 'container' as const,
      probedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      deniesUngrantedEffects: true,
      materializesGrants: true,
      probeSignals: ['docker'],
    }
    const decision = engine.evaluate(request, {
      config,
      attestation: freshAttestation,
    })
    expect(decision.outcome).toBe('require_approval')
    expect(decision.matchedRule).not.toBe('boundary.verified')
    expect(decision.matchedRule).toBe('builtin.outside_repo')
  })

  it('allows boundary.verified for repo-local routine writes with fresh materializing attestation', () => {
    const request = buildShellCapabilityRequest({
      command: 'touch notes.txt',
      hookKind: 'shell',
      segmentHead: 'touch',
      effect: 'local_mutation',
      location: 'repo_local',
      opacity: 'transparent',
      pathArgs: [`${repoRoot}/notes.txt`],
      resolvedPathTargets: [`${repoRoot}/notes.txt`],
      signals: ['repo_local_write'],
      cwd: repoRoot,
      repoRoot,
      inputFingerprint: 'fp-touch-verified',
    })
    request.evidence.level = 'certain'
    const freshAttestation = {
      version: 1 as const,
      driver: 'container' as const,
      probedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      deniesUngrantedEffects: true,
      materializesGrants: true,
      probeSignals: ['docker'],
    }
    const decision = engine.evaluate(request, {
      config,
      attestation: freshAttestation,
    })
    expect(decision.outcome).toBe('allow')
    expect(decision.matchedRule).toBe('boundary.verified')
  })

  it('does not match boundary.verified when repo-local path is outside container mount cwd', () => {
    const subCwd = `${repoRoot}/packages/a`
    const request = buildShellCapabilityRequest({
      command: 'touch ../b/notes.txt',
      hookKind: 'shell',
      segmentHead: 'touch',
      effect: 'local_mutation',
      location: 'repo_local',
      opacity: 'transparent',
      pathArgs: [`${repoRoot}/packages/b/notes.txt`],
      resolvedPathTargets: [`${repoRoot}/packages/b/notes.txt`],
      signals: ['repo_local_write'],
      cwd: subCwd,
      repoRoot,
      inputFingerprint: 'fp-touch-sibling',
    })
    request.evidence.level = 'certain'
    const freshAttestation = {
      version: 1 as const,
      driver: 'container' as const,
      probedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      deniesUngrantedEffects: true,
      materializesGrants: true,
      probeSignals: ['docker'],
    }
    const decision = engine.evaluate(request, {
      config,
      attestation: freshAttestation,
    })
    expect(decision.outcome).toBe('allow')
    expect(decision.matchedRule).not.toBe('boundary.verified')
    expect(decision.matchedRule).toBe('builtin.repo_local')
  })

  it('does not widen indeterminate effects via boundary materialization', () => {
    const freshAttestation = {
      version: 1 as const,
      driver: 'container' as const,
      probedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      deniesUngrantedEffects: true,
      materializesGrants: true,
      probeSignals: ['docker'],
    }
    const { decision } = evaluateShellPolicy(
      {
        command: '$(touch notes.txt)',
        hookKind: 'shell',
        segmentHead: 'touch',
        effect: 'unknown',
        location: 'unknown',
        opacity: 'unparseable',
        pathArgs: [],
        signals: ['unparseable_shell'],
        cwd: repoRoot,
        repoRoot,
        inputFingerprint: 'fp-unparseable',
      },
      config,
      { attestation: freshAttestation, egressProxyActive: true },
    )
    expect(decision.outcome).toBe('require_approval')
    expect(decision.matchedRule).not.toBe('grant.exact')
    expect(decision.matchedRule).not.toBe('boundary.verified')
  })

  it('does not allow boundary.verified without materializing attestation', () => {
    const request = buildShellCapabilityRequest({
      command: 'touch /tmp/outside.txt',
      hookKind: 'shell',
      segmentHead: 'touch',
      effect: 'local_mutation',
      location: 'repo_outside',
      opacity: 'transparent',
      pathArgs: ['/tmp/outside.txt'],
      resolvedPathTargets: ['/tmp/outside.txt'],
      signals: ['outside_repo_path'],
      cwd: repoRoot,
      repoRoot,
      inputFingerprint: 'fp-outside-shell',
    })
    const freshAttestation = {
      version: 1 as const,
      driver: 'container' as const,
      probedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      deniesUngrantedEffects: true,
      materializesGrants: false,
      probeSignals: ['host-integration'],
    }
    const decision = engine.evaluate(request, {
      config,
      attestation: freshAttestation,
    })
    expect(decision.outcome).toBe('require_approval')
    expect(decision.matchedRule).not.toBe('boundary.verified')
    expect(decision.reason).toBe('outside_repo_mutation')
  })

  it('fails closed when boundary attestation is stale', () => {
    const request = buildShellCapabilityRequest({
      command: 'touch /tmp/outside.txt',
      hookKind: 'shell',
      segmentHead: 'touch',
      effect: 'local_mutation',
      location: 'repo_outside',
      opacity: 'transparent',
      pathArgs: ['/tmp/outside.txt'],
      resolvedPathTargets: ['/tmp/outside.txt'],
      signals: ['outside_repo_path'],
      cwd: repoRoot,
      repoRoot,
      inputFingerprint: 'fp-outside-shell-stale',
    })
    const staleAttestation = {
      version: 1 as const,
      driver: 'container' as const,
      probedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      deniesUngrantedEffects: true,
      materializesGrants: true,
      probeSignals: ['docker'],
    }
    const decision = engine.evaluate(request, {
      config,
      attestation: staleAttestation,
    })
    expect(decision.outcome).toBe('require_approval')
    expect(decision.matchedRule).not.toBe('boundary.verified')
    expect(decision.reason).toBe('outside_repo_mutation')
  })
})
