import type { ClassifierOptions, ControlPlaneIntegrity, ScrubOptions, UnknownLocalEffectPolicy, UnparseableShellPolicy } from './types.js';
export type BelayMode = 'enforce' | 'audit';
export type { UnknownLocalEffectPolicy };
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
export interface BelayConfidenceThresholds {
    allow: number;
    flag: number;
}
export interface BelayModelAssistConfig {
    enabled: boolean;
    model?: string;
    timeoutMs?: number;
}
export interface BelayPolicyConfig {
    unknownLocalEffect: UnknownLocalEffectPolicy;
    unparseableShell: UnparseableShellPolicy;
    confidenceThresholds: BelayConfidenceThresholds;
    modelAssist: BelayModelAssistConfig;
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
    integrity: ControlPlaneIntegrity;
    /** Run OQ3 control-plane filesystem spike on beforeSubmitPrompt (dogfood / validation). */
    spikeOnPrompt?: boolean;
}
export interface BelayClassifierConfig {
    strictChains: boolean;
    sensitivePaths: string[];
}
export interface BelayNotificationsConfig {
    webhookUrl?: string;
    commandHook?: string;
}
export interface BelayApprovalSigningConfig {
    /** When true, out-of-band approvals must present a signed token. */
    required: boolean;
}
export interface BelayEgressConfig {
    enabled: boolean;
    listenHost: string;
    listenPort: number;
    /** When true with egress enabled, L3 external command lists become hints only. */
    demoteL3External: boolean;
}
export interface BelayConfigV3 {
    version: 3;
    adapter?: 'cursor' | 'claude';
    mode: BelayMode;
    approvalTtlMinutes: number;
    tokenPrefix: string;
    gates: BelayConfigV2['gates'];
    classifier: BelayClassifierConfig;
    policy: BelayPolicyConfig;
    overrides: BelayOverridesConfig;
    redaction: BelayRedactionConfig;
    controlPlane: BelayControlPlaneConfig;
    notifications: BelayNotificationsConfig;
    approvalSigning: BelayApprovalSigningConfig;
    egress: BelayEgressConfig;
    audit: BelayConfigV2['audit'];
}
export type BelayConfig = BelayConfigV3;
/** Pre-v0.4 defaults preserved when migrating existing v1/v2/v3 configs. */
export declare const DEFAULT_CONFIDENCE_THRESHOLDS: BelayConfidenceThresholds;
export declare const DEFAULT_MODEL_ASSIST: BelayModelAssistConfig;
export declare const LEGACY_POLICY_V3: BelayPolicyConfig;
/** Fresh v0.4+ install defaults (fail-closed). */
export declare const DEFAULT_POLICY_V3: BelayPolicyConfig;
export declare const DEFAULT_OVERRIDES_V3: BelayOverridesConfig;
export declare const DEFAULT_REDACTION_V3: BelayRedactionConfig;
export declare const LEGACY_CONTROL_PLANE_V3: BelayControlPlaneConfig;
export declare const DEFAULT_CONTROL_PLANE_V3: BelayControlPlaneConfig;
export declare const DEFAULT_NOTIFICATIONS_V3: BelayNotificationsConfig;
export declare const DEFAULT_APPROVAL_SIGNING_V3: BelayApprovalSigningConfig;
export declare const DEFAULT_EGRESS_V3: BelayEgressConfig;
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
export declare function isFreshConfigInput(loaded: unknown): boolean;
export declare function mergeConfig(existing: unknown, defaults?: BelayConfigV3): BelayConfigV3;
export declare function scrubOptionsFromConfig(config: BelayConfigV3): ScrubOptions;
export declare function classifierOptionsFromConfig(config: BelayConfigV3): ClassifierOptions;
export declare function defaultControlPlaneDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolveControlPlaneDir(config: BelayConfigV3): string;
/** Control-plane directory regardless of enabled flag (for orphan migration). */
export declare function configuredControlPlaneDir(config: BelayConfigV3): string;
export declare function belayStateDir(config: BelayConfigV3, repoLocalStateDir: string): string;
export declare function pendingApprovalsFile(config: BelayConfigV3, repoLocalStateDir: string): string;
export declare function approvedApprovalsFile(config: BelayConfigV3, repoLocalStateDir: string): string;
