import type { ClassifierOptions } from './types.js';
export type BelayMode = 'enforce' | 'audit';
export type UnknownLocalEffectPolicy = 'allow_flagged' | 'deny';
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
export interface BelayPolicyConfig {
    unknownLocalEffect: UnknownLocalEffectPolicy;
}
export interface BelayOverridesConfig {
    allow: string[];
    external: string[];
}
export interface BelayRedactionConfig {
    maskApprovalIds: boolean;
    maskBearerTokens: boolean;
    maskAuthHeaders: boolean;
    maskKeyValueSecrets: boolean;
    maskHighEntropyStrings: boolean;
}
export interface BelayControlPlaneConfig {
    enabled: boolean;
    configDir: string | null;
}
export interface BelayClassifierConfig {
    strictChains: boolean;
    sensitivePaths: string[];
}
export interface BelayConfigV3 {
    version: 3;
    mode: BelayMode;
    approvalTtlMinutes: number;
    tokenPrefix: string;
    gates: BelayConfigV2['gates'];
    classifier: BelayClassifierConfig;
    policy: BelayPolicyConfig;
    overrides: BelayOverridesConfig;
    redaction: BelayRedactionConfig;
    controlPlane: BelayControlPlaneConfig;
    audit: BelayConfigV2['audit'];
}
export type BelayConfig = BelayConfigV3;
export declare const DEFAULT_POLICY_V3: BelayPolicyConfig;
export declare const DEFAULT_OVERRIDES_V3: BelayOverridesConfig;
export declare const DEFAULT_REDACTION_V3: BelayRedactionConfig;
export declare const DEFAULT_CONTROL_PLANE_V3: BelayControlPlaneConfig;
export declare const DEFAULT_CONFIG_V2: BelayConfigV2;
export declare const DEFAULT_CONFIG_V3: BelayConfigV3;
export declare function mapLegacyClassifierToOverrides(classifier: {
    customAllowCommands?: string[];
    customExternalCommands?: string[];
}): BelayOverridesConfig;
export declare function migrateV2ToV3(v2: BelayConfigV2, rawOverrides?: Partial<BelayOverridesConfig>): BelayConfigV3;
export declare function isConfigV1(value: unknown): value is BelayConfigV1;
export declare function isConfigV2(value: unknown): value is BelayConfigV2;
export declare function isConfigV3(value: unknown): value is BelayConfigV3;
export declare function migrateConfig(loaded: unknown): BelayConfigV3;
export declare function normalizeConfigV2(config: BelayConfigV2): BelayConfigV2;
/** @deprecated Use normalizeConfig for v3 configs. */
export declare function normalizeConfig(config: BelayConfigV3): BelayConfigV3;
export declare function normalizeConfig(config: BelayConfigV2): BelayConfigV2;
export declare function mergeConfig(existing: unknown, defaults?: BelayConfigV3): BelayConfigV3;
export declare function classifierOptionsFromConfig(config: BelayConfigV3): ClassifierOptions;
export declare function defaultControlPlaneDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolveControlPlaneDir(config: BelayConfigV3): string;
