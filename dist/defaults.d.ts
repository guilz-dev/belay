import { type BelayConfigV3 } from './core/config.js';
export declare const PACKAGE_NAME = "agent-belay";
export declare const DEFAULT_CONFIG: BelayConfigV3;
export type ManagedHookDefinition = {
    command: string;
    placement: 'prepend' | 'append';
    matcher?: string;
};
export declare function getManagedHookEntries(platform?: NodeJS.Platform): Array<{
    event: string;
    definition: ManagedHookDefinition;
}>;
/** @deprecated Use getManagedHookEntries instead. */
export declare function getManagedHookEvents(platform?: NodeJS.Platform): Record<string, ManagedHookDefinition>;
export declare const EMPTY_APPROVALS: {
    readonly version: 1;
    readonly approvals: readonly [];
};
