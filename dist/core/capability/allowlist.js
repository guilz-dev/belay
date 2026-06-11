import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { belayStateDir } from '../config.js';
import { canonicalPath, pathWithinRoot } from '../path-utils.js';
export function fsScopeAllowlistPath(config, repoLocalStateDir) {
    return path.join(belayStateDir(config, repoLocalStateDir), 'fs-scope-allowlist.json');
}
export async function loadFsScopeAllowlist(filePath) {
    if (!existsSync(filePath)) {
        return { version: 1, paths: [] };
    }
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    return {
        version: 1,
        paths: Array.isArray(raw.paths) ? raw.paths : [],
    };
}
export function loadFsScopeAllowlistSync(filePath) {
    if (!existsSync(filePath)) {
        return { version: 1, paths: [] };
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    return {
        version: 1,
        paths: Array.isArray(raw.paths) ? raw.paths : [],
    };
}
export async function saveFsScopeAllowlist(filePath, state) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
export function normalizeAllowlistPath(targetPath) {
    return canonicalPath(targetPath);
}
export function isPathAllowlisted(absolutePath, allowlist) {
    const resolved = normalizeAllowlistPath(absolutePath);
    return allowlist.paths.some((entry) => {
        const scope = normalizeAllowlistPath(entry.path);
        return resolved === scope || pathWithinRoot(scope, resolved);
    });
}
export function allPathsAllowlisted(absolutePaths, allowlist) {
    return (absolutePaths.length > 0 && absolutePaths.every((entry) => isPathAllowlisted(entry, allowlist)));
}
export function addPathToAllowlist(allowlist, entry) {
    const normalized = normalizeAllowlistPath(entry.path);
    const filtered = allowlist.paths.filter((existing) => normalizeAllowlistPath(existing.path) !== normalized);
    return {
        version: 1,
        paths: [...filtered, { ...entry, path: normalized }],
    };
}
