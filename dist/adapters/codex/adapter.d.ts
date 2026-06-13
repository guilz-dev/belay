import type { BelayAdapter } from '../types.js';
export declare const codexAdapter: BelayAdapter;
export declare function codexPaths(repoRoot: string): {
    config: string;
    hooks: string;
    runtime: string;
};
