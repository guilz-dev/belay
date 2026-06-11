import type { Assessment, ConfidenceThresholds, HookVerdict } from './types.js';
import type { BlastRadiusScope, ShellAttributes } from './policy/types.js';
export declare function blastRadiusLabel(scope: BlastRadiusScope): string;
export declare function computeAssessmentFromAttributes(attributes: ShellAttributes): Assessment;
/** Corpus-calibrated confidence: strong signals increase, ambiguity decreases. */
export declare function calibrateConfidence(attributes: ShellAttributes, base: number): number;
export declare function verdictFromConfidence(assessment: Assessment, thresholds: ConfidenceThresholds, unknownLocalEffect: 'allow_flagged' | 'deny'): HookVerdict;
export declare function mergeAgentAssessment(independent: Assessment, agent?: Assessment): {
    assessment: Assessment;
    mismatch: boolean;
};
