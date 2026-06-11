import type { AdapterName } from './adapters/layouts/types.js';
import type { HooksFile, InitOptions, UpgradeOptions } from './types.js';
export declare function loadHooksFile(hooksPath: string): Promise<HooksFile>;
export declare function mergeHooksFile(current: HooksFile): HooksFile;
export declare function initCursorProject(options?: InitOptions): Promise<{
    repoRoot: string;
    withSkill: boolean;
}>;
export declare function upgradeCursorProject(options?: UpgradeOptions): Promise<{
    repoRoot: string;
}>;
export declare function initProject(options?: InitOptions): Promise<{
    repoRoot: string;
    withSkill: boolean;
    dogfood: boolean;
    adapter: AdapterName;
}>;
export declare function upgradeProject(options?: UpgradeOptions): Promise<{
    repoRoot: string;
    adapter: AdapterName;
}>;
