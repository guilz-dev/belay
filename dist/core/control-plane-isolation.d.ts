import type { BelayControlPlaneIsolationConfig } from './config.js';
export interface ControlPlaneIsolationReport {
    ok: boolean;
    mode: BelayControlPlaneIsolationConfig['mode'];
    controlPlaneDir: string;
    issues: string[];
    agentWritable: boolean;
    observedOwnerUid: number | null;
}
export declare function verifyControlPlaneIsolation(controlPlaneDir: string, isolation: BelayControlPlaneIsolationConfig): ControlPlaneIsolationReport;
