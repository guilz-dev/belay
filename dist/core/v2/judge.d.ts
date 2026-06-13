import type { ScrubOptions } from '../types.js';
import type { Tier1Judge, Tier1Verdict } from './types.js';
export interface Tier1JudgeTrace {
    provider: 'openai-compatible' | 'ollama' | 'fallback';
    modelRequested: string;
    modelResolved: string;
    latencyMs: number;
    outboundRedacted?: boolean;
    fallbackReason?: string;
}
export interface TracedTier1Judge extends Tier1Judge {
    lastTrace?: Tier1JudgeTrace;
}
export declare function prescanInterpreterCode(code: string): Tier1Verdict | null;
/** Conservative stub: Tier1 defers to Tier0; returns safe negatives for structural suite. */
export declare function createDeterministicJudgeStub(): TracedTier1Judge;
/** Fail-closed judge for when Tier1 is required but unavailable. */
export declare function createFailClosedJudge(): TracedTier1Judge;
export interface OllamaJudgeOptions {
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
    keepAlive?: string | null;
    fetchImpl?: typeof fetch;
}
export declare function createOllamaJudge(options?: OllamaJudgeOptions): TracedTier1Judge;
export interface OpenAiCompatibleJudgeOptions {
    endpoint: string;
    modelRequested: string;
    modelResolved: string;
    timeoutMs: number;
    apiKey?: string;
    sensitivePaths: string[];
    scrubOptions: ScrubOptions;
    fetchImpl?: typeof fetch;
}
export declare function createOpenAiCompatibleJudge(options: OpenAiCompatibleJudgeOptions): TracedTier1Judge;
/** @deprecated Use createOpenAiCompatibleJudge */
export declare const createCursorJudge: typeof createOpenAiCompatibleJudge;
export interface CursorJudgeOptions extends OpenAiCompatibleJudgeOptions {
}
export declare function tier1RequiresAsk(verdict: Tier1Verdict): boolean;
