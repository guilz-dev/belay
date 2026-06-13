import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { doctorProject } from '../../commands/doctor.js';
import { approvedApprovalsPath, mergeAndWriteConfig, pendingApprovalsPath, } from '../../config-io.js';
import { runtimeIntegrityFiles, writeIntegrityManifest } from '../../core/integrity.js';
import { EMPTY_APPROVALS } from '../../defaults.js';
import { buildRunnerScript, buildWindowsRunnerScript } from '../../node-resolution.js';
import { renderAuditHook, renderBeforeSubmitHook, renderRuntimeCore, renderShellGateHook, renderToolGateHook, } from '../../templates.js';
import { codexLayout } from '../layouts/codex.js';
import { getCodexManagedHookEntries, mergeCodexHooksToml } from './hooks.js';
async function loadCodexConfigToml(configTomlPath) {
    if (!existsSync(configTomlPath)) {
        return '';
    }
    return readFile(configTomlPath, 'utf8');
}
async function writeRuntimeArtifacts(repoRoot) {
    const hooksDir = codexLayout.hooksDir(repoRoot);
    const runtimeDir = codexLayout.runtimeDir(repoRoot);
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
    await write(path.join(runtimeDir, 'core.mjs'), await renderRuntimeCore('codex'));
    await write(path.join(hooksDir, 'belay-runner'), buildRunnerScript(process.execPath), true);
    await write(path.join(hooksDir, 'belay-runner.cmd'), buildWindowsRunnerScript(process.execPath));
}
async function writeCodexIntegrityManifest(repoRoot) {
    await writeIntegrityManifest(repoRoot, codexLayout, runtimeIntegrityFiles(codexLayout, repoRoot));
}
async function writeCodexHooksConfig(repoRoot) {
    const configTomlPath = codexLayout.hooksSettingsPath(repoRoot);
    const existing = await loadCodexConfigToml(configTomlPath);
    const merged = mergeCodexHooksToml(existing, process.platform);
    await mkdir(path.dirname(configTomlPath), { recursive: true });
    await writeFile(configTomlPath, merged, 'utf8');
}
async function installCodexBase(repoRoot) {
    const belayDir = codexLayout.repoLocalStateDir(repoRoot);
    const config = await mergeAndWriteConfig(repoRoot, 'codex');
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
    await writeCodexHooksConfig(repoRoot);
    await writeCodexIntegrityManifest(repoRoot);
}
export const codexAdapter = {
    name: 'codex',
    layout: codexLayout,
    async install(repoRoot, _options = {}) {
        await installCodexBase(repoRoot);
        return { repoRoot, withSkill: false };
    },
    async upgrade(repoRoot, _options = {}) {
        await mergeAndWriteConfig(repoRoot, 'codex');
        await writeRuntimeArtifacts(repoRoot);
        await writeCodexHooksConfig(repoRoot);
        await writeCodexIntegrityManifest(repoRoot);
        return { repoRoot };
    },
    async doctor(options = {}) {
        return doctorProject({ ...options, adapter: 'codex' });
    },
    hookEvents() {
        return getCodexManagedHookEntries(process.platform);
    },
};
export function codexPaths(repoRoot) {
    const resolved = path.resolve(repoRoot);
    return {
        config: codexLayout.configPath(resolved),
        hooks: codexLayout.hooksSettingsPath(resolved),
        runtime: path.join(codexLayout.runtimeDir(resolved), 'core.mjs'),
    };
}
