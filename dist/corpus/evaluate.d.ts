import type { HookVerdict } from '../core/types.js';
export interface CorpusCase {
    command: string;
    verdict: HookVerdict;
    reason?: string;
}
export interface CorpusMetrics {
    total: number;
    correct: number;
    accuracy: number;
    precision: Record<string, number>;
    recall: Record<string, number>;
    falsePositiveRate: number;
    mismatches: Array<{
        command: string;
        expected: string;
        actual: string;
        reason: string;
    }>;
}
export declare function loadCorpusCases(corpusDir: string): Promise<CorpusCase[]>;
export declare function evaluateCorpus(cases: CorpusCase[], repoRoot?: string): CorpusMetrics;
export declare function runCorpusEvaluation(corpusDir?: string): Promise<CorpusMetrics>;
