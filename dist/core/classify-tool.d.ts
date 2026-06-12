import type { BelayConfigV3 } from './config.js';
import type { ClassifierOptions, ClassifyResult } from './types.js';
export declare function classifyToolUse(payload: Record<string, unknown>, repoRoot: string, cwd: string, config: BelayConfigV3, options?: ClassifierOptions): Promise<ClassifyResult>;
