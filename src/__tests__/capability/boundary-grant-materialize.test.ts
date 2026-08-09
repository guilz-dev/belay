import { describe, expect, it } from 'vitest'

import { mintCapabilityGrant } from '../../core/capability/approval-v3.js'
import {
  BOUNDARY_GRANT_ISSUER_CONTAINER,
  materializeContainerBoundaryGrant,
  materializeContainerBoundaryGrants,
} from '../../core/capability/boundary-grant-materialize.js'
import { buildShellCapabilityRequest } from '../../core/capability/policy-engine.js'
import { DEFAULT_CONFIG_V4 } from '../../core/config.js'

describe('materializeContainerBoundaryGrant', () => {
  const repoRoot = '/tmp/belay-repo'
  const freshAttestation = {
    version: 1 as const,
    driver: 'container' as const,
    probedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    deniesUngrantedEffects: true,
    materializesGrants: true,
    probeSignals: ['docker', 'repo-mount-ro-default'],
  }

  it('materializes repo-local fs grants within mount root', () => {
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
      inputFingerprint: 'fp-touch',
    })
    const grant = materializeContainerBoundaryGrant(request, {
      attestation: freshAttestation,
      mountRoot: repoRoot,
      egressProxyActive: false,
      sensitivePaths: DEFAULT_CONFIG_V4.classifier.sensitivePaths,
    })
    expect(grant?.issuer).toBe(BOUNDARY_GRANT_ISSUER_CONTAINER)
    expect(grant?.action).toBe('fs.write')
  })

  it('does not materialize when evidence is not certain', () => {
    const request = buildShellCapabilityRequest({
      command: 'touch notes.txt',
      hookKind: 'shell',
      segmentHead: 'touch',
      effect: 'local_mutation',
      location: 'repo_local',
      opacity: 'opaque',
      pathArgs: [`${repoRoot}/notes.txt`],
      resolvedPathTargets: [`${repoRoot}/notes.txt`],
      signals: ['opaque_execution'],
      cwd: repoRoot,
      repoRoot,
      inputFingerprint: 'fp-touch-opaque',
    })
    expect(request.evidence.level).toBe('possible')
    const grant = materializeContainerBoundaryGrant(request, {
      attestation: freshAttestation,
      mountRoot: repoRoot,
      egressProxyActive: false,
    })
    expect(grant).toBeNull()
  })

  it('does not materialize outside-repo paths', () => {
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
      inputFingerprint: 'fp-outside',
    })
    const grant = materializeContainerBoundaryGrant(request, {
      attestation: freshAttestation,
      mountRoot: repoRoot,
      egressProxyActive: false,
    })
    expect(grant).toBeNull()
  })

  it('materializes network grants only with egress proxy and prior approval grant', () => {
    const request = buildShellCapabilityRequest({
      command: 'curl https://example.com',
      hookKind: 'shell',
      segmentHead: 'curl',
      effect: 'remote_mutation',
      location: 'external',
      opacity: 'transparent',
      pathArgs: [],
      signals: ['network_connect'],
      cwd: repoRoot,
      repoRoot,
      inputFingerprint: 'fp-curl',
    })
    request.action = 'network.connect'
    request.resource = { kind: 'network', host: 'example.com' }

    const withoutApproval = materializeContainerBoundaryGrant(request, {
      attestation: freshAttestation,
      mountRoot: repoRoot,
      egressProxyActive: true,
    })
    expect(withoutApproval).toBeNull()

    const approval = mintCapabilityGrant({
      approval: {
        approvalId: 'belay_test',
        kind: 'shell',
        fingerprint: 'fp-curl',
        repoRoot,
        reason: 'external_effect',
        summary: 'curl https://example.com',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      capabilityRequests: [request],
    })
    const withApproval = materializeContainerBoundaryGrant(request, {
      attestation: freshAttestation,
      mountRoot: repoRoot,
      egressProxyActive: true,
      existingGrants: approval ? [approval] : [],
    })
    expect(withApproval?.issuer).toBe(BOUNDARY_GRANT_ISSUER_CONTAINER)
    expect(withApproval?.action).toBe('network.connect')
  })

  it('materializes one grant per eligible request in a bundle', () => {
    const fsRequest = buildShellCapabilityRequest({
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
      inputFingerprint: 'fp-touch-bundle',
    })
    const grants = materializeContainerBoundaryGrants([fsRequest], {
      attestation: freshAttestation,
      mountRoot: repoRoot,
      egressProxyActive: false,
      sensitivePaths: DEFAULT_CONFIG_V4.classifier.sensitivePaths,
    })
    expect(grants).toHaveLength(1)
    expect(grants[0]?.action).toBe('fs.write')
  })
})
