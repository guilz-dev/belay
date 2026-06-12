import type { Assessment, ConfidenceThresholds, HookVerdict } from './types.js';
export declare function verdictFromConfidence(assessment: Assessment, thresholds: ConfidenceThresholds, unknownLocalEffect: 'allow_flagged' | 'deny'): HookVerdict;
export declare function mergeAgentAssessment(independent: Assessment, agent?: Assessment): {
    assessment: Assessment;
    mismatch: boolean;
};
