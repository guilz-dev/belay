import type { BelayConfigV3 } from '../config.js';
import type { ClassifierOptions, ClassifyResult } from '../types.js';
import type { Tier1Judge, VerdictContext, VerdictResult } from './types.js';
export declare function buildVerdictContext(params: {
    cwd: string;
    repoRoot: string;
    config: BelayConfigV3;
    options?: ClassifierOptions;
    judge?: Tier1Judge;
    trustedCwd?: boolean;
}): VerdictContext;
export declare function classifyShellV2(command: string, cwd: string, repoRoot: string, config: BelayConfigV3, options?: ClassifierOptions, judge?: Tier1Judge): Promise<ClassifyResult>;
export declare function verdictToClassifyResult(result: VerdictResult): ClassifyResult;
export declare function verdictAuditFields(result: VerdictResult): Record<string, unknown>;
