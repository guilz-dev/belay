import type { ManagedHookDefinition } from '../../defaults.js';
export interface ClaudeHookGroup {
    matcher?: string;
    hooks: Array<{
        type: 'command';
        command: string;
    }>;
}
export declare function getClaudeManagedHookGroups(platform?: NodeJS.Platform): Record<string, ClaudeHookGroup[]>;
export declare function getClaudeManagedHookEntries(platform?: NodeJS.Platform): Array<{
    event: string;
    definition: ManagedHookDefinition;
}>;
