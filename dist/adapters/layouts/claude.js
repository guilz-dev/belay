import path from 'node:path';
import { DEFAULT_CONFIG_V4 } from '../../core/config.js';
import { buildRunnerInvocation } from './scope.js';
function runnerCommand(platform, repoRoot, hookName, ...args) {
    const hooksDir = path.join(path.resolve(repoRoot), '.claude', 'hooks');
    return buildRunnerInvocation(platform, hooksDir, repoRoot, hookName, ...args);
}
export const claudeLayout = {
    name: 'claude',
    configPath(repoRoot) {
        return path.join(repoRoot, '.claude', 'belay.config.json');
    },
    hooksSettingsPath(repoRoot) {
        return path.join(repoRoot, '.claude', 'settings.json');
    },
    hooksDir(repoRoot) {
        return path.join(repoRoot, '.claude', 'hooks');
    },
    runtimeDir(repoRoot) {
        return path.join(repoRoot, '.claude', 'belay', 'runtime');
    },
    repoLocalStateDir(repoRoot) {
        return path.join(repoRoot, '.claude', 'belay');
    },
    defaultAuditLogPath(_repoRoot) {
        return path.join('.claude', 'belay', 'audit.ndjson');
    },
    repoRootMarkers: ['.git', '.claude'],
    runnerCommand,
    defaultConfig(repoRoot) {
        return {
            ...DEFAULT_CONFIG_V4,
            adapter: 'claude',
            audit: {
                ...DEFAULT_CONFIG_V4.audit,
                logPath: claudeLayout.defaultAuditLogPath(repoRoot),
            },
        };
    },
};
