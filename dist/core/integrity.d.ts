import type { ScopedPaths } from '../adapters/layouts/scope.js';
import type { AdapterLayout } from '../adapters/layouts/types.js';
export interface IntegrityManifest {
    version: 1;
    generatedAt: string;
    files: Record<string, string>;
}
export declare function sha256File(filePath: string): Promise<string>;
export declare function integrityManifestPath(layout: AdapterLayout, repoRoot: string): string;
export declare function runtimeIntegrityFiles(_layout: AdapterLayout, paths: ScopedPaths): string[];
export declare function writeIntegrityManifest(repoRoot: string, layout: AdapterLayout, filePaths: string[]): Promise<void>;
export declare function verifyIntegrityManifest(repoRoot: string, layout: AdapterLayout): Promise<{
    ok: boolean;
    mismatches: string[];
}>;
