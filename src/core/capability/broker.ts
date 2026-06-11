import type { BelayConfigV3 } from '../config.js'

export function isSandboxBrokerEnabled(config: BelayConfigV3): boolean {
  return config.sandbox.enabled
}

export function hasSandboxRuntime(config: BelayConfigV3): boolean {
  return config.sandbox.enabled && config.sandbox.runtime !== 'none'
}

/** FS-scope demotion requires a configured external sandbox runtime, not sandbox.enabled alone. */
export function isCapabilityBrokerDemotionActive(config: BelayConfigV3): boolean {
  return hasSandboxRuntime(config)
}

export interface L1FullStatus {
  active: boolean
  sandbox: boolean
  egress: boolean
  egressProxyRunning: boolean
  controlPlaneIsolation: boolean
  approvalSigningRequired: boolean
}

export function evaluateL1FullStatus(params: {
  config: BelayConfigV3
  egressProxyRunning: boolean
}): L1FullStatus {
  const sandbox = hasSandboxRuntime(params.config)
  const egress = params.config.egress.enabled
  const controlPlaneIsolation = params.config.controlPlane.isolation.mode !== 'none'
  const approvalSigningRequired = params.config.approvalSigning.required
  const active =
    sandbox &&
    egress &&
    params.egressProxyRunning &&
    controlPlaneIsolation &&
    approvalSigningRequired

  return {
    active,
    sandbox,
    egress,
    egressProxyRunning: params.egressProxyRunning,
    controlPlaneIsolation,
    approvalSigningRequired,
  }
}
