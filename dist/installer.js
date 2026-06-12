import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cursorLayout } from './adapters/layouts/cursor.js';
import { getAdapter } from './adapters/registry.js';
import { dogfoodProject } from './commands/dogfood.js';
import { approvedApprovalsPath, detectAdapterName, loadConfigFile, mergeAndWriteConfig, pendingApprovalsPath, writeConfigFile, } from './config-io.js';
import { isFreshConfigInput, mergeConfig, normalizeConfig } from './core/config.js';
import { runtimeIntegrityFiles, writeIntegrityManifest } from './core/integrity.js';
import { resolveInitJudgeConfig } from './core/judge-config.js';
import { EMPTY_APPROVALS, getManagedHookEntries } from './defaults.js';
import { buildRunnerScript, buildWindowsRunnerScript } from './node-resolution.js';
import { applyConfigPreset } from './presets.js';
import { renderAuditHook, renderBeforeSubmitHook, renderRuntimeCore, renderShellGateHook, renderToolGateHook, } from './templates.js';
const BUNDLED_SKILL_TEMPLATE_URL = new URL('../skills/belay/SKILL.md', import.meta.url);
const BUNDLED_COMMAND_TEMPLATE_URL = new URL('../skills/belay/belay-approve.md', import.meta.url);
async function pathExists(filePath) {
    try {
        await stat(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function ensureDir(dirPath) {
    await mkdir(dirPath, { recursive: true });
}
async function writeTextFile(filePath, content, executable = false) {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, content, 'utf8');
    if (executable) {
        await chmod(filePath, 0o755);
    }
}
async function writeJsonIfMissing(filePath, value) {
    if (await pathExists(filePath)) {
        return;
    }
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
async function writeTextIfMissing(filePath, content) {
    if (await pathExists(filePath)) {
        return;
    }
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, content, 'utf8');
}
async function readBundledTemplate(fileUrl) {
    try {
        return await readFile(fileUrl, 'utf8');
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown read failure.';
        throw new Error(`Bundled template missing at ${fileUrl.pathname}: ${detail}`);
    }
}
export async function loadHooksFile(hooksPath) {
    if (!existsSync(hooksPath)) {
        return { version: 1, hooks: {} };
    }
    const raw = await readFile(hooksPath, 'utf8');
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'number') {
            throw new Error('hooks.json must contain a numeric version field.');
        }
        if (!parsed.hooks || typeof parsed.hooks !== 'object') {
            throw new Error('hooks.json must contain an object hooks field.');
        }
        return parsed;
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown JSON parse failure.';
        throw new Error(`Invalid hooks.json at ${hooksPath}: ${detail}`);
    }
}
function entryMatches(existing, expected) {
    return existing.command === expected.command && existing.matcher === expected.matcher;
}
function mergeHookEntry(current, expected, placement) {
    const entries = Array.isArray(current) ? [...current] : [];
    const filtered = entries.filter((entry) => !entryMatches(entry, expected));
    if (placement === 'prepend') {
        return [expected, ...filtered];
    }
    return [...filtered, expected];
}
export function mergeHooksFile(current) {
    const next = {
        version: current.version || 1,
        hooks: { ...current.hooks },
    };
    const managedEntries = getManagedHookEntries(process.platform);
    for (const { event, definition } of managedEntries) {
        next.hooks[event] = mergeHookEntry(next.hooks[event], {
            command: definition.command,
            matcher: definition.matcher,
        }, definition.placement);
    }
    return next;
}
async function writeCursorRuntimeArtifacts(repoRoot) {
    const hooksDir = cursorLayout.hooksDir(repoRoot);
    const runtimeDir = cursorLayout.runtimeDir(repoRoot);
    await writeTextFile(path.join(hooksDir, 'belay-before-submit.mjs'), renderBeforeSubmitHook());
    await writeTextFile(path.join(hooksDir, 'belay-shell-gate.mjs'), renderShellGateHook());
    await writeTextFile(path.join(hooksDir, 'belay-tool-gate.mjs'), renderToolGateHook());
    await writeTextFile(path.join(hooksDir, 'belay-audit.mjs'), renderAuditHook());
    await writeTextFile(path.join(runtimeDir, 'core.mjs'), await renderRuntimeCore('cursor'));
    await writeTextFile(path.join(hooksDir, 'belay-runner'), buildRunnerScript(process.execPath), true);
    await writeTextFile(path.join(hooksDir, 'belay-runner.cmd'), buildWindowsRunnerScript(process.execPath));
}
async function writeCursorIntegrityManifest(repoRoot) {
    await writeIntegrityManifest(repoRoot, cursorLayout, runtimeIntegrityFiles(cursorLayout, repoRoot));
}
async function writeSkillArtifacts(repoRoot) {
    const cursorDir = path.join(repoRoot, '.cursor');
    const skillsDir = path.join(cursorDir, 'skills', 'belay');
    const commandsDir = path.join(cursorDir, 'commands');
    await ensureDir(skillsDir);
    await ensureDir(commandsDir);
    const bundledSkill = await readBundledTemplate(BUNDLED_SKILL_TEMPLATE_URL);
    const bundledCommand = await readBundledTemplate(BUNDLED_COMMAND_TEMPLATE_URL);
    await writeTextFile(path.join(skillsDir, 'SKILL.md'), bundledSkill);
    await writeTextFile(path.join(commandsDir, 'belay-approve.md'), bundledCommand);
}
export async function initCursorProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const withSkill = options.withSkill === true;
    const hooksPath = cursorLayout.hooksSettingsPath(repoRoot);
    const belayDir = cursorLayout.repoLocalStateDir(repoRoot);
    const hooksFile = await loadHooksFile(hooksPath);
    const mergedHooks = mergeHooksFile(hooksFile);
    await ensureDir(cursorLayout.hooksDir(repoRoot));
    await ensureDir(path.join(belayDir, 'runtime'));
    await ensureDir(belayDir);
    const config = await mergeAndWriteConfig(repoRoot, 'cursor');
    await writeCursorRuntimeArtifacts(repoRoot);
    await writeJsonIfMissing(pendingApprovalsPath(repoRoot, config), EMPTY_APPROVALS);
    await writeJsonIfMissing(approvedApprovalsPath(repoRoot, config), EMPTY_APPROVALS);
    await writeTextIfMissing(path.join(belayDir, 'audit.ndjson'), '');
    if (withSkill) {
        await writeSkillArtifacts(repoRoot);
    }
    await writeFile(hooksPath, `${JSON.stringify(mergedHooks, null, 2)}\n`, 'utf8');
    await writeCursorIntegrityManifest(repoRoot);
    return { repoRoot, withSkill };
}
export async function upgradeCursorProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    await mergeAndWriteConfig(repoRoot, 'cursor');
    await writeCursorRuntimeArtifacts(repoRoot);
    const hooksPath = cursorLayout.hooksSettingsPath(repoRoot);
    const hooksFile = await loadHooksFile(hooksPath);
    const merged = mergeHooksFile(hooksFile);
    await writeFile(hooksPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    if (options.withSkill) {
        await writeSkillArtifacts(repoRoot);
    }
    await writeCursorIntegrityManifest(repoRoot);
    return { repoRoot };
}
function resolveAdapterName(options, repoRoot) {
    if (options.adapter === 'claude') {
        return 'claude';
    }
    if (options.adapter === 'cursor') {
        return 'cursor';
    }
    if (repoRoot) {
        return detectAdapterName(repoRoot);
    }
    return 'cursor';
}
async function applyInitJudgeConfig(repoRoot, adapterName, options) {
    if (options.skipJudgeWrite) {
        return;
    }
    const layout = getAdapter(adapterName).layout;
    const configPath = layout.configPath(repoRoot);
    let existingConfig = {};
    if (await pathExists(configPath)) {
        existingConfig = JSON.parse(await readFile(configPath, 'utf8'));
    }
    const isFresh = isFreshConfigInput(existingConfig);
    const mergedConfig = await loadConfigFile(repoRoot, adapterName);
    const hasExplicitJudgeFlags = options.judgeProfile || options.judgeProvider || options.judgeModel;
    const judge = resolveInitJudgeConfig({
        isFresh,
        hasExplicitJudgeFlags: Boolean(hasExplicitJudgeFlags),
        judgeProfile: options.judgeProfile,
        judgeProvider: options.judgeProvider,
        judgeModel: options.judgeModel,
        acceptCloudJudge: options.acceptCloudJudge,
        existingJudge: mergedConfig.judge,
    });
    const configWithJudge = normalizeConfig({ ...mergedConfig, version: 4, judge });
    await writeConfigFile(repoRoot, configWithJudge, adapterName);
}
export async function initProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const adapterName = resolveAdapterName(options, repoRoot);
    const adapter = getAdapter(adapterName);
    const result = await adapter.install(repoRoot, options);
    await applyInitJudgeConfig(repoRoot, adapterName, options);
    if (options.preset) {
        const existing = await loadConfigFile(repoRoot, adapterName);
        const presetConfig = mergeConfig(applyConfigPreset(options.preset));
        const merged = mergeConfig(presetConfig, existing);
        await writeConfigFile(repoRoot, merged, adapterName);
    }
    if (options.dogfood === true) {
        await dogfoodProject({ targetDir: repoRoot, adapter: adapterName });
    }
    return {
        repoRoot,
        withSkill: result.withSkill,
        dogfood: options.dogfood === true,
        adapter: adapterName,
    };
}
export async function upgradeProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const adapterName = resolveAdapterName(options, repoRoot);
    await getAdapter(adapterName).upgrade(repoRoot, options);
    return { repoRoot, adapter: adapterName };
}
