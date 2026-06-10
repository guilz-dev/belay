import { type BelayConfigV3 } from './core/config.js';
export interface CleanupOrphanResult {
    actions: string[];
}
export declare function cleanupOrphanApprovalState(repoRoot: string, config: BelayConfigV3, options?: {
    dryRun?: boolean;
}): Promise<CleanupOrphanResult>;
