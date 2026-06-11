import path from 'node:path';
import { DEFAULT_CONFIG_V3, mergeConfig } from './config.js';
import { applyConfigPreset } from '../presets.js';
export function teamConfigPath(homedir = () => process.env.HOME ?? process.env.USERPROFILE ?? '') {
    const xdg = process.env.XDG_CONFIG_HOME?.trim();
    const base = xdg || path.join(homedir(), '.config');
    return path.join(base, 'agent-belay', 'team.config.json');
}
function applyProtectedLayer(config, builtin) {
    const controlPlane = { ...config.controlPlane };
    if (builtin.controlPlane.enabled && controlPlane.enabled === false) {
        controlPlane.enabled = true;
    }
    if (builtin.controlPlane.integrity === 'hash-pinned' &&
        controlPlane.integrity === 'none') {
        controlPlane.integrity = 'hash-pinned';
    }
    return {
        ...config,
        controlPlane,
    };
}
function asV3Layer(raw) {
    if (!raw || typeof raw !== 'object') {
        return { version: 3 };
    }
    return { version: 3, ...raw };
}
function mergeConfigLayer(base, layer) {
    const merged = mergeConfig(layer, base);
    if (!layer.policy) {
        return { ...merged, policy: base.policy };
    }
    return merged;
}
export function resolveLayeredConfig(params) {
    const provenance = [
        { path: '(builtin)', source: 'builtin' },
    ];
    let config = mergeConfig({}, params.adapterDefaults);
    if (params.teamConfig) {
        const teamFile = params.teamConfig;
        const teamRaw = teamFile.preset
            ? applyConfigPreset(teamFile.preset, teamFile.config ?? {})
            : (teamFile.config ?? params.teamConfig);
        config = mergeConfigLayer(config, asV3Layer(teamRaw));
        provenance.push({
            path: params.teamConfigPath ?? teamConfigPath(),
            source: 'team',
        });
    }
    config = mergeConfigLayer(config, asV3Layer(params.repoConfig));
    if (params.repoConfigPath) {
        provenance.push({ path: params.repoConfigPath, source: 'repo' });
    }
    const protectedConfig = applyProtectedLayer(config, DEFAULT_CONFIG_V3);
    if (JSON.stringify(protectedConfig) !== JSON.stringify(config)) {
        provenance.push({ path: '(protected-layer)', source: 'protected' });
        config = protectedConfig;
    }
    return { config, provenance };
}
