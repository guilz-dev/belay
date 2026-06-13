import type { ScopedPaths } from '../adapters/layouts/scope.js';
import type { AdapterName } from '../adapters/layouts/types.js';
export declare function writeRuntimeArtifacts(adapterName: AdapterName, paths: ScopedPaths): Promise<void>;
