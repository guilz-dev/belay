import path from 'node:path';
import { matchesSensitivePath } from '../glob.js';
import { canonicalPath, pathWithinRoot, relativeWithinRepo, resolveMutationTarget, } from '../path-utils.js';
function expandHome(token) {
    if (token === '~' || token.startsWith('~/')) {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
        if (!home) {
            return token;
        }
        return token === '~' ? home : path.join(home, token.slice(2));
    }
    return token;
}
export function resolveTrustedPath(token, trustedCwd, trusted) {
    if (!token || token === '--' || token.startsWith('-')) {
        return null;
    }
    if (!trusted || !trustedCwd) {
        return null;
    }
    const expanded = expandHome(token);
    if (path.isAbsolute(expanded)) {
        return canonicalPath(expanded);
    }
    return canonicalPath(path.resolve(trustedCwd, expanded));
}
export function locationForPath(resolvedPath, repoRoot) {
    if (!resolvedPath) {
        return 'unknown';
    }
    if (pathWithinRoot(repoRoot, resolvedPath)) {
        return 'repo_local';
    }
    return 'repo_outside';
}
export function isGitPath(resolvedPath, repoRoot) {
    const relative = relativeWithinRepo(repoRoot, resolvedPath);
    if (!relative) {
        return false;
    }
    const normalized = relative.replaceAll('\\', '/');
    return normalized === '.git' || normalized.startsWith('.git/');
}
export function isHighStakesPath(resolvedPath, repoRoot, sensitivePaths, protectedRoots = []) {
    if (isGitPath(resolvedPath, repoRoot)) {
        return true;
    }
    const relative = relativeWithinRepo(repoRoot, resolvedPath);
    const checkPath = relative ?? resolvedPath;
    if (matchesSensitivePath(checkPath.replaceAll('\\', '/'), sensitivePaths)) {
        return true;
    }
    return protectedRoots.some((root) => pathWithinRoot(root, resolvedPath));
}
export function analyzePathTargets(params) {
    const signals = [];
    if (!params.trustedCwd || !params.cwd) {
        return {
            location: 'unknown',
            isHighStakes: false,
            signals: ['missing_trusted_cwd'],
        };
    }
    const locations = new Set();
    let isHighStakes = false;
    for (const target of params.targets) {
        const resolved = resolveTrustedPath(target, params.cwd, params.trustedCwd) ??
            resolveMutationTarget(target, params.cwd);
        const location = locationForPath(resolved, params.repoRoot);
        locations.add(location);
        if (resolved &&
            isHighStakesPath(resolved, params.repoRoot, params.sensitivePaths, params.protectedArtifactRoots)) {
            isHighStakes = true;
            signals.push('high_stakes_path');
        }
    }
    let location = 'unknown';
    if (locations.size === 0) {
        location = 'unknown';
    }
    else if (locations.size === 1) {
        location = [...locations][0] ?? 'unknown';
    }
    else {
        location = 'mixed';
    }
    return { location, isHighStakes, signals };
}
export function cwdRelative(repoRoot, cwd) {
    return relativeWithinRepo(repoRoot, cwd) ?? cwd;
}
