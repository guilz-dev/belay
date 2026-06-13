import { type ScopedPaths } from '../adapters/layouts/scope.js';
import type { AdapterName } from '../adapters/layouts/types.js';
import type { BelayConfigV4 } from '../core/config.js';
import type { InitOptions, UpgradeOptions } from '../types.js';
export type OperationScope = 'project' | 'global';
export declare function resolveOperationScope(repoRoot: string, adapter: AdapterName, options?: InitOptions | UpgradeOptions): Promise<OperationScope>;
export declare function applyInstallScope(repoRoot: string, adapter: AdapterName, scope: OperationScope, config?: BelayConfigV4): Promise<BelayConfigV4>;
export declare function pathsForOperation(adapter: AdapterName, scope: OperationScope, repoRoot: string): ScopedPaths;
