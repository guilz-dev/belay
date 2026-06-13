import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { doctorProject } from '../../commands/doctor.js';
import { mergeAndWriteConfig } from '../../config-io.js';
import { runtimeIntegrityFiles, writeIntegrityManifest } from '../../core/integrity.js';
import { bootstrapStateFiles, writeSkillArtifacts } from '../../installer/bootstrap.js';
import { writeRuntimeArtifacts } from '../../installer/runtime-artifacts.js';
import { applyInstallScope, resolveOperationScope } from '../../installer/scope-config.js';
import { claudeLayout } from '../layouts/claude.js';
import { resolveScopedPaths } from '../layouts/scope.js';
import { getClaudeManagedHookGroups } from './hooks.js';
function hookCommandMatches(existing, expectedCommand) {
    if (!existing || typeof existing !== 'object') {
        return false;
    }
    const record = existing;
    return (Array.isArray(record.hooks) &&
        record.hooks.some((hook) => hook.type === 'command' && hook.command === expectedCommand));
}
function mergeClaudeHookGroup(current, expected) {
    const entries = Array.isArray(current) ? [...current] : [];
    const expectedCommand = expected.hooks[0]?.command;
    const filtered = entries.filter((entry) => {
        if (!expectedCommand) {
            return true;
        }
        return !hookCommandMatches(entry, expectedCommand);
    });
    return [expected, ...filtered];
}
async function loadClaudeSettings(settingsPath) {
    if (!existsSync(settingsPath)) {
        return {};
    }
    const raw = await readFile(settingsPath, 'utf8');
    return JSON.parse(raw);
}
function mergeClaudeSettings(current, platform, hooksDir, repoRoot) {
    const managed = getClaudeManagedHookGroups(platform, hooksDir, repoRoot);
    const hooks = { ...(current.hooks ?? {}) };
    for (const [event, groups] of Object.entries(managed)) {
        let eventHooks = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
        for (const group of groups) {
            eventHooks = mergeClaudeHookGroup(eventHooks, group);
        }
        hooks[event] = eventHooks;
    }
    return {
        ...current,
        hooks,
    };
}
async function installClaudeBase(repoRoot, options) {
    const scope = await resolveOperationScope(repoRoot, 'claude', options);
    const paths = resolveScopedPaths(claudeLayout, scope, repoRoot);
    const settingsPath = paths.hooksSettingsPath;
    const settings = mergeClaudeSettings(await loadClaudeSettings(settingsPath), process.platform, paths.hooksDir, repoRoot);
    const config = await mergeAndWriteConfig(repoRoot, 'claude');
    await applyInstallScope(repoRoot, 'claude', scope, config);
    await writeRuntimeArtifacts('claude', paths);
    await bootstrapStateFiles(repoRoot, config, paths);
    if (options.withSkill) {
        await writeSkillArtifacts('claude', paths);
    }
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await writeIntegrityManifest(repoRoot, claudeLayout, runtimeIntegrityFiles(claudeLayout, paths));
}
export const claudeAdapter = {
    name: 'claude',
    layout: claudeLayout,
    async install(repoRoot, options = {}) {
        await installClaudeBase(repoRoot, options);
        return { repoRoot, withSkill: options.withSkill === true };
    },
    async upgrade(repoRoot, options = {}) {
        const scope = await resolveOperationScope(repoRoot, 'claude', options);
        const paths = resolveScopedPaths(claudeLayout, scope, repoRoot);
        const config = await mergeAndWriteConfig(repoRoot, 'claude');
        await applyInstallScope(repoRoot, 'claude', scope, config);
        await writeRuntimeArtifacts('claude', paths);
        const settingsPath = paths.hooksSettingsPath;
        const settings = mergeClaudeSettings(await loadClaudeSettings(settingsPath), process.platform, paths.hooksDir, repoRoot);
        await mkdir(path.dirname(settingsPath), { recursive: true });
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
        if (options.withSkill) {
            await writeSkillArtifacts('claude', paths);
        }
        await writeIntegrityManifest(repoRoot, claudeLayout, runtimeIntegrityFiles(claudeLayout, paths));
        return { repoRoot };
    },
    async doctor(options = {}) {
        return doctorProject({ ...options, adapter: 'claude' });
    },
    hookEvents() {
        return getClaudeManagedHookGroups(process.platform, claudeLayout.hooksDir(process.cwd()), process.cwd()).PreToolUse.map((group) => ({
            event: 'PreToolUse',
            definition: {
                command: group.hooks[0]?.command ?? '',
                placement: 'prepend',
                matcher: group.matcher,
            },
        }));
    },
};
export function claudePaths(repoRoot) {
    const resolved = path.resolve(repoRoot);
    return {
        config: claudeLayout.configPath(resolved),
        hooks: claudeLayout.hooksSettingsPath(resolved),
        runtime: path.join(claudeLayout.runtimeDir(resolved), 'core.mjs'),
    };
}
