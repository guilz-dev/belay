import type { Assessment } from './types.js';
import type { GitProbeResult } from './recover-git-probe.js';
export interface RecoverTargetInput {
    timestamp?: string;
    fingerprint?: string;
    summary: string;
    reason: string;
    effect?: string;
    location?: string;
    permission?: string;
    assessment?: Assessment;
}
export interface RecoverAdviceInput {
    repoRoot: string;
    target: RecoverTargetInput;
    git?: GitProbeResult;
}
export interface RecoverAdviceResult {
    recoverable: boolean;
    confidence: 'high' | 'medium';
    disclaimer: string[];
    advice: string[];
    warnings: string[];
}
export declare const RECOVER_DISCLAIMER: string[];
export declare const SHOW_DONT_RUN_LEAD = "These steps may help undo the observed effect \u2014 confirm each step before running:";
export declare function containsDeniedRecoveryPattern(text: string): boolean;
export declare function buildRecoverAdvice(input: RecoverAdviceInput): RecoverAdviceResult;
