import type { BoundaryAttestation } from '../core/capability/attestation.js'
import { isAttestationFresh } from '../core/capability/attestation.js'
import { evaluateL1FullStatus } from '../core/capability/broker.js'
import type { BelayConfigV4 } from '../core/config.js'
import type { LayerProfileId } from './types.js'

export interface GuaranteePosture {
  configuredProfile: LayerProfileId
  attestedProfile: LayerProfileId
  attestationFresh: boolean
  l1FullConfigured: boolean
  l1FullAttested: boolean
  postureMismatch: boolean
}

export function resolveConfiguredProfile(
  config: BelayConfigV4,
  egressProxyRunning: boolean,
): LayerProfileId {
  const l1Full = evaluateL1FullStatus({ config, egressProxyRunning })
  if (l1Full.active) {
    return 'l1-full'
  }
  if (config.egress.enabled) {
    return 'l1-partial-egress'
  }
  if (config.policy.transactional.enabled) {
    return 'l1-l2-transactional'
  }
  return 'l3-l4-only'
}

export function resolveAttestedProfile(params: {
  attestation: BoundaryAttestation | null
  l1FullConfigured: boolean
}): LayerProfileId {
  if (!params.attestation || !isAttestationFresh(params.attestation)) {
    return 'l3-l4-only'
  }
  if (
    params.l1FullConfigured &&
    params.attestation.deniesUngrantedEffects &&
    params.attestation.materializesGrants
  ) {
    return 'l1-full'
  }
  return 'l3-l4-only'
}

export function evaluateGuaranteePosture(params: {
  config: BelayConfigV4
  attestation: BoundaryAttestation | null
  egressProxyRunning: boolean
}): GuaranteePosture {
  const l1Full = evaluateL1FullStatus({
    config: params.config,
    egressProxyRunning: params.egressProxyRunning,
  })
  const configuredProfile = resolveConfiguredProfile(params.config, params.egressProxyRunning)
  const attestedProfile = resolveAttestedProfile({
    attestation: params.attestation,
    l1FullConfigured: l1Full.active,
  })
  return {
    configuredProfile,
    attestedProfile,
    attestationFresh: params.attestation ? isAttestationFresh(params.attestation) : false,
    l1FullConfigured: l1Full.active,
    l1FullAttested:
      attestedProfile === 'l1-full' &&
      Boolean(params.attestation?.deniesUngrantedEffects && params.attestation.materializesGrants),
    postureMismatch: configuredProfile === 'l1-full' && attestedProfile !== 'l1-full',
  }
}
