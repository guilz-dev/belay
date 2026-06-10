import type { BelayAdapter } from '../types.js';
export declare const cursorAdapter: BelayAdapter;
export declare function cursorPaths(repoRoot: string): {
    config: string;
    hooks: string;
    runtime: string;
};
