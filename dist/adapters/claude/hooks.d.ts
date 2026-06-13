import type { ManagedHookDefinition } from '../../defaults.js';
export interface ClaudeHookGroup {
    matcher?: string;
    hooks: Array<{
        type: 'command';
        command: string;
    }>;
}
export declare function getClaudeManagedHookGroups(platform: NodeJS.Platform, hooksDir: string, repoRoot: string): Record<string, ClaudeHookGroup[]>;
export declare function getClaudeManagedHookEntries(platform?: NodeJS.Platform, hooksDir?: string, repoRoot?: string): Array<{
    event: string;
    definition: ManagedHookDefinition;
}>;
