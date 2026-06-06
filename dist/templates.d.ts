import type { BelayConfig } from './types.js';
export declare function renderConfig(config: BelayConfig): string;
export declare function renderBeforeSubmitHook(): string;
export declare function renderShellGateHook(): string;
export declare function renderToolGateHook(): string;
export declare function renderAuditHook(): string;
export declare function renderRuntimeCore(config: BelayConfig): string;
