import os from 'node:os';
import path from 'node:path';
function agentHomeDir(adapter) {
    const home = os.homedir();
    if (adapter === 'cursor') {
        return path.join(home, '.cursor');
    }
    if (adapter === 'claude') {
        return path.join(home, '.claude');
    }
    return path.join(home, '.codex');
}
function projectAgentDir(adapter, repoRoot) {
    if (adapter === 'cursor') {
        return path.join(repoRoot, '.cursor');
    }
    if (adapter === 'claude') {
        return path.join(repoRoot, '.claude');
    }
    return path.join(repoRoot, '.codex');
}
export function isPathInside(child, parent) {
    const resolvedChild = path.resolve(child);
    const resolvedParent = path.resolve(parent);
    const relative = path.relative(resolvedParent, resolvedChild);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
export function buildRunnerInvocation(platform, hooksDir, repoRoot, hookScript, ...args) {
    const runnerFile = platform === 'win32' ? 'belay-runner.cmd' : 'belay-runner';
    const runnerAbs = path.resolve(hooksDir, runnerFile);
    const relative = path.relative(path.resolve(repoRoot), runnerAbs);
    const useRelative = relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
    const runnerRef = useRelative
        ? platform === 'win32'
            ? `.\\${relative.split(path.sep).join('\\')}`
            : `./${relative.split(path.sep).join('/')}`
        : runnerAbs;
    return [runnerRef, hookScript, ...args].join(' ');
}
export function resolveScopedPaths(layout, scope, repoRoot) {
    const resolvedRepo = path.resolve(repoRoot);
    const adapter = layout.name;
    if (scope === 'managed') {
        throw new Error('managed install scope is not implemented yet. Use --scope project (default) or --scope global.');
    }
    const projectAgent = projectAgentDir(adapter, resolvedRepo);
    const project = {
        scope: 'project',
        repoRoot: resolvedRepo,
        configPath: layout.configPath(resolvedRepo),
        hooksSettingsPath: layout.hooksSettingsPath(resolvedRepo),
        hooksDir: layout.hooksDir(resolvedRepo),
        runtimeDir: layout.runtimeDir(resolvedRepo),
        repoLocalStateDir: layout.repoLocalStateDir(resolvedRepo),
        skillsDir: path.join(projectAgent, 'skills', 'belay'),
        commandsDir: adapter === 'cursor' ? path.join(projectAgent, 'commands') : undefined,
    };
    if (scope === 'project') {
        return project;
    }
    const globalAgent = agentHomeDir(adapter);
    return {
        scope: 'global',
        repoRoot: resolvedRepo,
        configPath: project.configPath,
        hooksSettingsPath: adapter === 'cursor'
            ? path.join(globalAgent, 'hooks.json')
            : adapter === 'claude'
                ? path.join(globalAgent, 'settings.json')
                : path.join(globalAgent, 'config.toml'),
        hooksDir: path.join(globalAgent, 'hooks'),
        runtimeDir: path.join(globalAgent, 'belay', 'runtime'),
        repoLocalStateDir: project.repoLocalStateDir,
        skillsDir: path.join(globalAgent, 'skills', 'belay'),
        commandsDir: adapter === 'cursor' ? path.join(globalAgent, 'commands') : undefined,
    };
}
export function resolveInstallScope(options, persisted, fallback = 'project') {
    if (options.scope === 'managed') {
        throw new Error('managed install scope is not implemented yet. Use --scope project (default) or --scope global.');
    }
    if (options.scope === 'global' || options.scope === 'project') {
        return options.scope;
    }
    return persisted ?? fallback;
}
