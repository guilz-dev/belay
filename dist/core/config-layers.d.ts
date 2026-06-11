import { type ConfigPresetName } from '../presets.js';
import type { BelayConfigV3 } from './config.js';
export type ConfigLayerSource = 'builtin' | 'team' | 'repo' | 'protected';
export interface ConfigProvenanceEntry {
    path: string;
    source: ConfigLayerSource;
}
export interface LayeredConfigResult {
    config: BelayConfigV3;
    provenance: ConfigProvenanceEntry[];
}
export interface TeamConfigFile {
    preset?: ConfigPresetName;
    config?: Record<string, unknown>;
}
export declare function teamConfigPath(homedir?: () => string): string;
export declare function resolveLayeredConfig(params: {
    repoConfig: unknown;
    adapterDefaults: BelayConfigV3;
    teamConfig?: TeamConfigFile | Record<string, unknown> | null;
    teamConfigPath?: string;
    repoConfigPath?: string;
}): LayeredConfigResult;
