import type { ScopedPaths } from '../adapters/layouts/scope.js';
import type { AdapterName } from '../adapters/layouts/types.js';
import type { BelayConfigV3 } from '../core/config.js';
export declare function bootstrapStateFiles(repoRoot: string, config: BelayConfigV3, paths: ScopedPaths): Promise<void>;
export declare function writeSkillArtifacts(adapterName: AdapterName, paths: ScopedPaths): Promise<void>;
