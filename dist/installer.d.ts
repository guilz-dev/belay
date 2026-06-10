import type { HooksFile, InitOptions, UpgradeOptions } from './types.js';
declare function loadHooksFile(hooksPath: string): Promise<HooksFile>;
declare function mergeHooksFile(current: HooksFile): HooksFile;
export declare function initProject(options?: InitOptions): Promise<{
    repoRoot: string;
    withSkill: boolean;
    dogfood: boolean;
}>;
export declare function upgradeProject(options?: UpgradeOptions): Promise<{
    repoRoot: string;
}>;
export { loadHooksFile, mergeHooksFile };
