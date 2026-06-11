export function isSandboxBrokerEnabled(config) {
    return config.sandbox.enabled;
}
export function evaluateL1FullStatus(params) {
    const sandbox = params.config.sandbox.enabled;
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
