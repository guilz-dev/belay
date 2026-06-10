import type { ClassifierOptions } from './types.js';
export type BelayMode = 'enforce' | 'audit';
export interface BelayConfigV1 {
    version: 1;
    mode: BelayMode;
    approvalTtlMinutes: number;
    tokenPrefix: string;
    gates: {
        shell: boolean;
        subagent: boolean;
    };
    audit: {
        logPath: string;
    };
}
export interface BelayConfigV2 {
    version: 2;
    mode: BelayMode;
    approvalTtlMinutes: number;
    tokenPrefix: string;
    gates: {
        shell: boolean;
        subagent: boolean;
        fileMutation: boolean;
        toolShell: boolean;
    };
    classifier: {
        strictChains: boolean;
        customExternalCommands: string[];
        customAllowCommands: string[];
        sensitivePaths: string[];
    };
    audit: {
        logPath: string;
        includeAssessment: boolean;
    };
}
export type BelayConfig = BelayConfigV2;
export declare const DEFAULT_CONFIG_V2: BelayConfigV2;
export declare function isConfigV1(value: unknown): value is BelayConfigV1;
export declare function migrateConfig(loaded: unknown): BelayConfigV2;
export declare function normalizeConfig(config: BelayConfigV2): BelayConfigV2;
export declare function mergeConfig(existing: unknown, defaults?: BelayConfigV2): BelayConfigV2;
export declare function classifierOptionsFromConfig(config: BelayConfigV2): ClassifierOptions;
