import type { BelayConfigV2 } from './core/config.js';
export declare function renderConfig(config: BelayConfigV2): string;
export declare function renderBeforeSubmitHook(): string;
export declare function renderShellGateHook(): string;
export declare function renderToolGateHook(): string;
export declare function renderAuditHook(): string;
export declare function renderRuntimeCore(): Promise<string>;
