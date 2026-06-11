export function isSandboxBrokerEnabled(config) {
    return config.sandbox.enabled;
}
export function hasSandboxRuntime(config) {
    return config.sandbox.enabled && config.sandbox.runtime !== 'none';
}
/** FS-scope demotion requires a configured external sandbox runtime, not sandbox.enabled alone. */
export function isCapabilityBrokerDemotionActive(config) {
    return hasSandboxRuntime(config);
}
export function evaluateL1FullStatus(params) {
    const sandbox = hasSandboxRuntime(params.config);
    const egress = params.config.egress.enabled;
    const controlPlaneIsolation = params.config.controlPlane.isolation.mode !== 'none';
    const approvalSigningRequired = params.config.approvalSigning.required;
    const active = sandbox &&
        egress &&
        params.egressProxyRunning &&
        controlPlaneIsolation &&
        approvalSigningRequired;
    return {
        active,
        sandbox,
        egress,
        egressProxyRunning: params.egressProxyRunning,
        controlPlaneIsolation,
        approvalSigningRequired,
    };
}
