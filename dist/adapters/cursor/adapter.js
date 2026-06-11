import path from 'node:path';
import { getManagedHookEntries } from '../../defaults.js';
import { doctorProject } from '../../doctor.js';
import { initCursorProject, upgradeCursorProject } from '../../installer.js';
import { cursorLayout } from '../layouts/cursor.js';
export const cursorAdapter = {
    name: 'cursor',
    layout: cursorLayout,
    async install(repoRoot, options = {}) {
        return initCursorProject({ ...options, targetDir: repoRoot });
    },
    async upgrade(repoRoot, options = {}) {
        return upgradeCursorProject({ ...options, targetDir: repoRoot });
    },
    async doctor(options = {}) {
        return doctorProject({ ...options, adapter: 'cursor' });
    },
    hookEvents() {
        return getManagedHookEntries(process.platform);
    },
};
export function cursorPaths(repoRoot) {
    const resolved = path.resolve(repoRoot);
    return {
        config: cursorLayout.configPath(resolved),
        hooks: cursorLayout.hooksSettingsPath(resolved),
        runtime: path.join(cursorLayout.runtimeDir(resolved), 'core.mjs'),
    };
}
