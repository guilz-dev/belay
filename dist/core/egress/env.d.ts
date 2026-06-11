import type { BelayEgressConfig } from '../config.js';
export declare function recommendedProxyEnv(egress: BelayEgressConfig): Record<string, string>;
export declare function formatProxyEnv(egress: BelayEgressConfig): string;
