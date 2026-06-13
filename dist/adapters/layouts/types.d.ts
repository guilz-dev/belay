import type { BelayConfigV3 } from '../../core/config.js';
export type AdapterName = 'cursor' | 'claude' | 'codex';
export interface AdapterLayout {
    name: AdapterName;
    configPath(repoRoot: string): string;
    hooksSettingsPath(repoRoot: string): string;
    hooksDir(repoRoot: string): string;
    runtimeDir(repoRoot: string): string;
    repoLocalStateDir(repoRoot: string): string;
    defaultAuditLogPath(repoRoot: string): string;
    repoRootMarkers: string[];
    runnerCommand(platform: NodeJS.Platform, repoRoot: string, hookName: string, ...args: string[]): string;
    defaultConfig(repoRoot: string): Partial<BelayConfigV3>;
}
