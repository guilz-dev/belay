import type { HooksFile, InitOptions } from './types.js';
declare function loadHooksFile(hooksPath: string): Promise<HooksFile>;
declare function mergeHooksFile(current: HooksFile): HooksFile;
export declare function initProject(options?: InitOptions): Promise<{
    repoRoot: string;
    withSkill: boolean;
}>;
export { loadHooksFile, mergeHooksFile };
