import type { AdapterLayout } from './types.js';
/** Repo-local and optional out-of-repo paths that must never be mutated via overrides. */
export declare function protectedArtifactRoots(layout: AdapterLayout, repoRoot: string, controlPlaneDir?: string | null): string[];
