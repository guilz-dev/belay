import type { ShellAttributes } from './policy/types.js';
import type { Assessment } from './types.js';
export interface ModelAssistConfig {
    enabled: boolean;
    model?: string;
    timeoutMs?: number;
    apiKeyEnv?: string;
}
export interface ModelAssistInput {
    command: string;
    attributes: ShellAttributes;
    heuristicAssessment: Assessment;
}
/**
 * Optional LLM assist for ambiguous middle band. Default off; failures degrade to heuristic.
 */
export declare function maybeAssistAssessment(input: ModelAssistInput, config: ModelAssistConfig): Promise<{
    assessment: Assessment;
    assisted: boolean;
}>;
