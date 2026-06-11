import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { approvedApprovalsPath, mergeAndWriteConfig, pendingApprovalsPath, } from '../../config-io.js';
import { runtimeIntegrityFiles, writeIntegrityManifest } from '../../core/integrity.js';
import { EMPTY_APPROVALS } from '../../defaults.js';
import { doctorProject } from '../../doctor.js';
import { buildRunnerScript, buildWindowsRunnerScript } from '../../node-resolution.js';
import { renderAuditHook, renderBeforeSubmitHook, renderRuntimeCore, renderShellGateHook, renderToolGateHook, } from '../../templates.js';
import { claudeLayout } from '../layouts/claude.js';
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
function mergeClaudeSettings(current) {
    const managed = getClaudeManagedHookGroups(process.platform);
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
async function writeRuntimeArtifacts(repoRoot) {
    const hooksDir = claudeLayout.hooksDir(repoRoot);
    const runtimeDir = claudeLayout.runtimeDir(repoRoot);
    await mkdir(hooksDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    const write = async (filePath, content, executable = false) => {
        await writeFile(filePath, content, 'utf8');
        if (executable) {
            await chmod(filePath, 0o755);
        }
    };
    await write(path.join(hooksDir, 'belay-before-submit.mjs'), renderBeforeSubmitHook());
    await write(path.join(hooksDir, 'belay-shell-gate.mjs'), renderShellGateHook());
    await write(path.join(hooksDir, 'belay-tool-gate.mjs'), renderToolGateHook());
    await write(path.join(hooksDir, 'belay-audit.mjs'), renderAuditHook());
    await write(path.join(runtimeDir, 'core.mjs'), await renderRuntimeCore('claude'));
    await write(path.join(hooksDir, 'belay-runner'), buildRunnerScript(process.execPath), true);
    await write(path.join(hooksDir, 'belay-runner.cmd'), buildWindowsRunnerScript(process.execPath));
}
async function writeClaudeIntegrityManifest(repoRoot) {
    await writeIntegrityManifest(repoRoot, claudeLayout, runtimeIntegrityFiles(claudeLayout, repoRoot));
}
async function installClaudeBase(repoRoot) {
    const settingsPath = claudeLayout.hooksSettingsPath(repoRoot);
    const belayDir = claudeLayout.repoLocalStateDir(repoRoot);
    const settings = mergeClaudeSettings(await loadClaudeSettings(settingsPath));
    const config = await mergeAndWriteConfig(repoRoot, 'claude');
    await mkdir(belayDir, { recursive: true });
    await writeRuntimeArtifacts(repoRoot);
    const writeJsonIfMissing = async (filePath, value) => {
        if (!existsSync(filePath)) {
            await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        }
    };
    await writeJsonIfMissing(pendingApprovalsPath(repoRoot, config), EMPTY_APPROVALS);
    await writeJsonIfMissing(approvedApprovalsPath(repoRoot, config), EMPTY_APPROVALS);
    const auditPath = path.join(repoRoot, config.audit.logPath);
    if (!existsSync(auditPath)) {
        await mkdir(path.dirname(auditPath), { recursive: true });
        await writeFile(auditPath, '', 'utf8');
    }
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await writeClaudeIntegrityManifest(repoRoot);
}
export const claudeAdapter = {
    name: 'claude',
    layout: claudeLayout,
    async install(repoRoot, _options = {}) {
        await installClaudeBase(repoRoot);
        return { repoRoot, withSkill: false };
    },
    async upgrade(repoRoot, _options = {}) {
        await mergeAndWriteConfig(repoRoot, 'claude');
        await writeRuntimeArtifacts(repoRoot);
        const settingsPath = claudeLayout.hooksSettingsPath(repoRoot);
        const settings = mergeClaudeSettings(await loadClaudeSettings(settingsPath));
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
        await writeClaudeIntegrityManifest(repoRoot);
        return { repoRoot };
    },
    async doctor(options = {}) {
        return doctorProject({ ...options, adapter: 'claude' });
    },
    hookEvents() {
        return getClaudeManagedHookGroups(process.platform).PreToolUse.map((group) => ({
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
