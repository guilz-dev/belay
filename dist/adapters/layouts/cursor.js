import path from 'node:path';
import { DEFAULT_CONFIG_V4 } from '../../core/config.js';
function runnerCommand(platform, hookName, ...args) {
    const base = platform === 'win32' ? '.\\.cursor\\hooks\\belay-runner.cmd' : './.cursor/hooks/belay-runner';
    return [base, hookName, ...args].join(' ');
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
