import path from 'node:path';
export function relativeWithinRepo(repoRoot, targetPath) {
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedTarget = path.resolve(targetPath);
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
        return path.resolve(token);
    }
    if (token.startsWith('./') || token.startsWith('../')) {
        return path.resolve(cwd, token);
    }
    if (!token.includes('/') && !token.includes('\\')) {
        return path.resolve(cwd, token);
    }
    return path.resolve(cwd, token);
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
