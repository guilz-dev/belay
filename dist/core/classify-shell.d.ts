import type { ClassifierOptions, ClassifyResult } from './types.js';
export declare function classifyShell(command: string, cwd: string, repoRoot: string, options?: ClassifierOptions, depth?: number): ClassifyResult;
