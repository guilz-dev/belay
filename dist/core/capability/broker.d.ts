import type { BelayConfigV3 } from '../config.js';
export declare function isSandboxBrokerEnabled(config: BelayConfigV3): boolean;
export declare function hasSandboxRuntime(config: BelayConfigV3): boolean;
/** FS-scope demotion requires a configured external sandbox runtime, not sandbox.enabled alone. */
export declare function isCapabilityBrokerDemotionActive(config: BelayConfigV3): boolean;
export interface L1FullStatus {
    active: boolean;
    sandbox: boolean;
    egress: boolean;
    egressProxyRunning: boolean;
    controlPlaneIsolation: boolean;
    approvalSigningRequired: boolean;
}
export declare function evaluateL1FullStatus(params: {
    config: BelayConfigV3;
    egressProxyRunning: boolean;
}): L1FullStatus;
