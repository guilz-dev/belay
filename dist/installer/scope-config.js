import { existsSync } from 'node:fs';
import { getAdapterLayout } from '../adapters/layouts/index.js';
import { resolveInstallScope, resolveScopedPaths, } from '../adapters/layouts/scope.js';
import { loadConfigFile, writeConfigFile } from '../config-io.js';
export async function resolveOperationScope(repoRoot, adapter, options = {}) {
    const layout = getAdapterLayout(adapter);
    let persisted;
    if (existsSync(layout.configPath(repoRoot))) {
        const config = await loadConfigFile(repoRoot, adapter);
        persisted = config.installScope;
    }
    return resolveInstallScope(options, persisted);
}
export async function applyInstallScope(repoRoot, adapter, scope, config) {
    const current = config ?? (await loadConfigFile(repoRoot, adapter));
    if (current.installScope === scope) {
        return current;
    }
    const updated = { ...current, installScope: scope };
    await writeConfigFile(repoRoot, updated, adapter);
    return updated;
}
export function pathsForOperation(adapter, scope, repoRoot) {
    return resolveScopedPaths(getAdapterLayout(adapter), scope, repoRoot);
}
