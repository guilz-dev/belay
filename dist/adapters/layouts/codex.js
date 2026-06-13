import path from 'node:path';
import { DEFAULT_CONFIG_V4 } from '../../core/config.js';
function runnerCommand(platform, hookName, ...args) {
    const base = platform === 'win32' ? '.\\.codex\\hooks\\belay-runner.cmd' : './.codex/hooks/belay-runner';
    return [base, hookName, ...args].join(' ');
}
// Codex hook config lives in `.codex/config.toml` (TOML `[[hooks.*]]`), distinct from
// Claude's JSON `settings.json`. belay's own config stays JSON at `.codex/belay.config.json`.
export const codexLayout = {
    name: 'codex',
    configPath(repoRoot) {
        return path.join(repoRoot, '.codex', 'belay.config.json');
    },
    // Codex reads lifecycle hooks from `.codex/config.toml` (project layer).
    hooksSettingsPath(repoRoot) {
        return path.join(repoRoot, '.codex', 'config.toml');
    },
    hooksDir(repoRoot) {
        return path.join(repoRoot, '.codex', 'hooks');
    },
    runtimeDir(repoRoot) {
        return path.join(repoRoot, '.codex', 'belay', 'runtime');
    },
    repoLocalStateDir(repoRoot) {
        return path.join(repoRoot, '.codex', 'belay');
    },
    defaultAuditLogPath(_repoRoot) {
        return path.join('.codex', 'belay', 'audit.ndjson');
    },
    repoRootMarkers: ['.git', '.codex'],
    runnerCommand,
    defaultConfig(repoRoot) {
        return {
            ...DEFAULT_CONFIG_V4,
            adapter: 'codex',
            audit: {
                ...DEFAULT_CONFIG_V4.audit,
                logPath: codexLayout.defaultAuditLogPath(repoRoot),
            },
        };
    },
};
