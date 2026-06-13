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
export interface BelayTransactionalConfig {
    enabled: boolean;
    minConfidence: number;
    maxConfidence: number;
    timeoutMs: number;
    maxDeletionCount: number;
    gates: {
        shell: boolean;
    };
}
export interface BelayPolicyConfig {
    unknownLocalEffect: UnknownLocalEffectPolicy;
    unparseableShell: UnparseableShellPolicy;
    confidenceThresholds: BelayConfidenceThresholds;
    modelAssist: BelayModelAssistConfig;
    transactional: BelayTransactionalConfig;
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
export type JudgeProvider = 'ollama' | 'openai-compatible';
export interface BelayJudgeConfig {
    provider: JudgeProvider;
    model: string;
    timeoutMs: number;
    endpoint: string | null;
    keepAlive: string | null;
}
export declare const DEFAULT_JUDGE_LOCAL_OLLAMA: BelayJudgeConfig;
export declare const DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE: BelayJudgeConfig;
/** @deprecated Use DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE */
export declare const DEFAULT_JUDGE_CURSOR_COMPOSER: BelayJudgeConfig;
export type ControlPlaneIsolationMode = 'none' | 'read-only-mount' | 'separate-user';
export interface BelayControlPlaneIsolationConfig {
    mode: ControlPlaneIsolationMode;
    expectedOwnerUid?: number;
    verifyAgentWritable: boolean;
}
export interface BelayControlPlaneConfig {
    enabled: boolean;
    configDir: string | null;
    integrity: ControlPlaneIntegrity;
    isolation: BelayControlPlaneIsolationConfig;
}
export type SandboxRuntime = 'none' | 'cursor-sandbox' | 'container' | 'seatbelt' | 'landlock';
export interface BelaySandboxConfig {
    enabled: boolean;
    runtime: SandboxRuntime;
    denyNetworkByDefault: boolean;
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
export interface BelayConfigV4 {
    version: 4;
    adapter?: 'cursor' | 'claude' | 'codex';
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
    sandbox: BelaySandboxConfig;
    audit: BelayConfigV2['audit'];
    judge: BelayJudgeConfig;
}
/** @deprecated Use BelayConfigV4 */
export type BelayConfigV3 = BelayConfigV4;
export type BelayConfig = BelayConfigV4;
/** Pre-v0.4 defaults preserved when migrating existing v1/v2/v3 configs. */
export declare const DEFAULT_CONFIDENCE_THRESHOLDS: BelayConfidenceThresholds;
export declare const DEFAULT_MODEL_ASSIST: BelayModelAssistConfig;
export declare const DEFAULT_TRANSACTIONAL_V3: BelayTransactionalConfig;
export declare const LEGACY_POLICY_V3: BelayPolicyConfig;
/** Fresh v0.4+ install defaults (fail-closed). */
export declare const DEFAULT_POLICY_V3: BelayPolicyConfig;
export declare const DEFAULT_OVERRIDES_V3: BelayOverridesConfig;
export declare const DEFAULT_REDACTION_V3: BelayRedactionConfig;
export declare const DEFAULT_CONTROL_PLANE_ISOLATION_V3: BelayControlPlaneIsolationConfig;
export declare const LEGACY_CONTROL_PLANE_V3: BelayControlPlaneConfig;
export declare const DEFAULT_CONTROL_PLANE_V3: BelayControlPlaneConfig;
export declare const DEFAULT_SANDBOX_V3: BelaySandboxConfig;
export declare const DEFAULT_NOTIFICATIONS_V3: BelayNotificationsConfig;
export declare const DEFAULT_APPROVAL_SIGNING_V3: BelayApprovalSigningConfig;
export declare const DEFAULT_EGRESS_V3: BelayEgressConfig;
export declare function normalizeEgressListenHost(host: string): string;
export declare const DEFAULT_CONFIG_V2: BelayConfigV2;
export declare const DEFAULT_CONFIG_V4: BelayConfigV4;
/** @deprecated Use DEFAULT_CONFIG_V4 */
export declare const DEFAULT_CONFIG_V3: BelayConfigV4;
export declare function mapLegacyClassifierToOverrides(classifier: {
    customAllowCommands?: string[];
    customExternalCommands?: string[];
}): BelayOverridesConfig;
export declare function migrateV2ToV3(v2: BelayConfigV2, rawOverrides?: Partial<BelayOverridesConfig>): BelayConfigV4;
export declare function isConfigV1(value: unknown): value is BelayConfigV1;
export declare function isConfigV2(value: unknown): value is BelayConfigV2;
export declare function isConfigV3(value: unknown): value is BelayConfigV4;
export declare function isConfigV4(value: unknown): value is BelayConfigV4;
export declare function normalizeJudgeProvider(provider: string | undefined): 'ollama' | 'openai-compatible';
export declare function normalizeJudgeConfig(judge: BelayJudgeConfig): BelayJudgeConfig;
export declare function migrateV3ToV4(v3: BelayConfigV4, raw?: RawConfigInput): BelayConfigV4;
type RawConfigInput = Partial<{
    version: number;
    judge: Partial<BelayJudgeConfig>;
    mode: BelayMode;
    approvalTtlMinutes: number;
    tokenPrefix: string;
    gates: Partial<BelayConfigV2['gates']>;
    classifier: Partial<BelayConfigV2['classifier']> & Partial<BelayClassifierConfig>;
    policy: Partial<BelayPolicyConfig>;
    overrides: Partial<BelayOverridesConfig>;
    redaction: Partial<BelayRedactionConfig>;
    controlPlane: Partial<BelayControlPlaneConfig>;
    notifications: Partial<BelayNotificationsConfig>;
    approvalSigning: Partial<BelayApprovalSigningConfig>;
    egress: Partial<BelayEgressConfig>;
    sandbox: Partial<BelaySandboxConfig>;
    audit: Partial<BelayConfigV2['audit']>;
}>;
export declare function migrateConfig(loaded: unknown): BelayConfigV4;
export declare function normalizeConfigV2(config: BelayConfigV2): BelayConfigV2;
export declare function normalizeConfig(config: BelayConfigV4): BelayConfigV4;
export declare function normalizeConfig(config: BelayConfigV2): BelayConfigV2;
export declare function isFreshConfigInput(loaded: unknown): boolean;
export declare function mergeConfig(existing: unknown, defaults?: BelayConfigV4): BelayConfigV4;
export declare function scrubOptionsFromConfig(config: BelayConfigV4): ScrubOptions;
export declare function classifierOptionsFromConfig(config: BelayConfigV4): ClassifierOptions;
export declare function defaultControlPlaneDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolveControlPlaneDir(config: BelayConfigV4): string;
/** Control-plane directory regardless of enabled flag (for orphan migration). */
export declare function configuredControlPlaneDir(config: BelayConfigV4): string;
export declare function belayStateDir(config: BelayConfigV4, repoLocalStateDir: string): string;
export declare function pendingApprovalsFile(config: BelayConfigV4, repoLocalStateDir: string): string;
export declare function approvedApprovalsFile(config: BelayConfigV4, repoLocalStateDir: string): string;
