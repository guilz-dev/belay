import type { Tier1Judge, Tier1Verdict } from './types.js';
export declare function prescanInterpreterCode(code: string): Tier1Verdict | null;
/** Conservative stub: Tier1 defers to Tier0; returns safe negatives for structural suite. */
export declare function createDeterministicJudgeStub(): Tier1Judge;
/** Fail-closed judge for when Tier1 is required but unavailable. */
export declare function createFailClosedJudge(): Tier1Judge;
export declare function createOllamaJudge(model?: string, baseUrl?: string): Tier1Judge;
export declare function tier1RequiresAsk(verdict: Tier1Verdict): boolean;
