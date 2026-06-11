import type { BelayConfigV3 } from './core/config.js';
export type ConfigPresetName = 'strict' | 'standard' | 'audit-first' | 'l1-full-recommended';
export declare const CONFIG_PRESETS: Record<ConfigPresetName, Partial<BelayConfigV3>>;
export declare function applyConfigPreset(preset: ConfigPresetName, extra?: Record<string, unknown>): Record<string, unknown>;
