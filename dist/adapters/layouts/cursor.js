import path from 'node:path';
import { DEFAULT_CONFIG_V4 } from '../../core/config.js';
import { buildRunnerInvocation } from './scope.js';
function runnerCommand(platform, repoRoot, hookName, ...args) {
    const hooksDir = path.join(path.resolve(repoRoot), '.cursor', 'hooks');
    return buildRunnerInvocation(platform, hooksDir, repoRoot, hookName, ...args);
}
export const cursorLayout = {
    name: 'cursor',
    configPath(repoRoot) {
        return path.join(repoRoot, '.cursor', 'belay.config.json');
    },
    hooksSettingsPath(repoRoot) {
        return path.join(repoRoot, '.cursor', 'hooks.json');
    },
    hooksDir(repoRoot) {
        return path.join(repoRoot, '.cursor', 'hooks');
    },
    runtimeDir(repoRoot) {
        return path.join(repoRoot, '.cursor', 'belay', 'runtime');
    },
    repoLocalStateDir(repoRoot) {
        return path.join(repoRoot, '.cursor', 'belay');
    },
    defaultAuditLogPath(_repoRoot) {
        return path.join('.cursor', 'belay', 'audit.ndjson');
    },
    repoRootMarkers: ['.git', '.cursor'],
    runnerCommand,
    defaultConfig(repoRoot) {
        return {
            ...DEFAULT_CONFIG_V4,
            adapter: 'cursor',
            audit: {
                ...DEFAULT_CONFIG_V4.audit,
                logPath: cursorLayout.defaultAuditLogPath(repoRoot),
            },
        };
    },
};
