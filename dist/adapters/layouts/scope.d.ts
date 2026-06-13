import type { AdapterLayout } from './types.js';
export type InstallScope = 'project' | 'global' | 'managed';
export interface ScopedPaths {
    scope: InstallScope;
    repoRoot: string;
    configPath: string;
    hooksSettingsPath: string;
    hooksDir: string;
    runtimeDir: string;
    repoLocalStateDir: string;
    skillsDir: string;
    commandsDir?: string;
}
export declare function isPathInside(child: string, parent: string): boolean;
export declare function buildRunnerInvocation(platform: NodeJS.Platform, hooksDir: string, repoRoot: string, hookScript: string, ...args: string[]): string;
export declare function resolveScopedPaths(layout: AdapterLayout, scope: InstallScope, repoRoot: string): ScopedPaths;
export declare function resolveInstallScope(options: {
    scope?: InstallScope;
}, persisted?: 'project' | 'global', fallback?: 'project' | 'global'): 'project' | 'global';
