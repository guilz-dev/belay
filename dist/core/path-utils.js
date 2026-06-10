import { realpathSync } from 'node:fs';
import path from 'node:path';
function resolveRealpath(targetPath) {
    try {
        return realpathSync.native(targetPath);
    }
    catch {
        return path.resolve(targetPath);
    }
}
export function pathWithinRoot(root, targetPath) {
    const resolvedRoot = resolveRealpath(root);
    const resolvedTarget = resolveRealpath(targetPath);
    const relativePath = path.relative(resolvedRoot, resolvedTarget);
    if (relativePath === '') {
        return true;
    }
    return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}
export function relativeWithinRepo(repoRoot, targetPath) {
    const resolvedRoot = resolveRealpath(repoRoot);
    const resolvedTarget = resolveRealpath(targetPath);
    const relativePath = path.relative(resolvedRoot, resolvedTarget);
    if (relativePath === '') {
        return '.';
    }
    if (relativePath.startsWith('..')) {
        return null;
    }
    return relativePath;
}
export function normalizeToken(token, repoRoot) {
    if (!path.isAbsolute(token)) {
        return token;
    }
    const relativePath = relativeWithinRepo(repoRoot, token);
    return relativePath ?? token;
}
export function resolveMutationTarget(token, cwd) {
    if (!token || token === '--' || token.startsWith('-')) {
        return null;
    }
    if (token === '2>' || token === '1>' || token === '&>' || token === '1>>' || token === '2>>') {
        return null;
    }
    if (path.isAbsolute(token)) {
        return resolveRealpath(token);
    }
    if (token.startsWith('./') || token.startsWith('../')) {
        return resolveRealpath(path.resolve(cwd, token));
    }
    if (!token.includes('/') && !token.includes('\\')) {
        return resolveRealpath(path.resolve(cwd, token));
    }
    return resolveRealpath(path.resolve(cwd, token));
}
export function hasOutsideRepoPath(tokens, cwd, repoRoot) {
    return tokens.some((token) => {
        const resolved = resolveMutationTarget(token, cwd);
        if (!resolved) {
            return false;
        }
        return relativeWithinRepo(repoRoot, resolved) === null;
    });
}
