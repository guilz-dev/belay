import path from 'node:path';
import { getManagedHookEntries } from '../../defaults.js';
import { doctorProject } from '../../doctor.js';
import { initProject, upgradeProject } from '../../installer.js';
export const cursorAdapter = {
    name: 'cursor',
    async install(repoRoot, options = {}) {
        return initProject({ ...options, targetDir: repoRoot });
    },
    async upgrade(repoRoot, options = {}) {
        return upgradeProject({ ...options, targetDir: repoRoot });
    },
    async doctor(options = {}) {
        return doctorProject(options);
    },
    hookEvents() {
        return getManagedHookEntries(process.platform);
    },
};
export function cursorPaths(repoRoot) {
    const resolved = path.resolve(repoRoot);
    return {
        config: path.join(resolved, '.cursor', 'belay.config.json'),
        hooks: path.join(resolved, '.cursor', 'hooks.json'),
        runtime: path.join(resolved, '.cursor', 'belay', 'runtime', 'core.mjs'),
    };
}
