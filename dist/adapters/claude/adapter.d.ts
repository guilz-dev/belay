import type { BelayAdapter } from '../types.js';
export declare const claudeAdapter: BelayAdapter;
export declare function claudePaths(repoRoot: string): {
    config: string;
    hooks: string;
    runtime: string;
};
