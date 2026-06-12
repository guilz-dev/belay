import path from 'node:path';
import { DEFAULT_CONFIG_V4 } from '../../core/config.js';
function runnerCommand(platform, hookName, ...args) {
    const base = platform === 'win32' ? '.\\.claude\\hooks\\belay-runner.cmd' : './.claude/hooks/belay-runner';
    return [base, hookName, ...args].join(' ');
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
