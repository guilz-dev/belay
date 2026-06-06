import type { BelayConfig } from './types.js';
export declare const PACKAGE_NAME = "agent-belay";
export type ManagedHookDefinition = {
    command: string;
    placement: 'prepend' | 'append';
    matcher?: string;
};
export declare function getManagedHookEvents(platform?: NodeJS.Platform): Record<string, ManagedHookDefinition>;
export declare const DEFAULT_CONFIG: BelayConfig;
export declare const EMPTY_APPROVALS: {
    readonly version: 1;
    readonly approvals: readonly [];
};
