import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, EMPTY_APPROVALS, getManagedHookEvents, } from './defaults.js';
import { buildRunnerScript, buildWindowsRunnerScript } from './node-resolution.js';
import { renderAuditHook, renderBeforeSubmitHook, renderConfig, renderNightlyCommand, renderNightlySkill, renderRuntimeCore, renderShellGateHook, renderToolGateHook, } from './templates.js';
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
async function loadHooksFile(hooksPath) {
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
function mergeHooksFile(current) {
    const next = {
        version: current.version || 1,
        hooks: { ...current.hooks },
    };
    const managedEntries = Object.entries(getManagedHookEvents(process.platform));
    for (const [eventName, definition] of managedEntries) {
        next.hooks[eventName] = mergeHookEntry(current.hooks[eventName], {
            command: definition.command,
            matcher: definition.matcher,
        }, definition.placement);
    }
    return next;
}
export async function initProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const nightly = options.nightly === true;
    const cursorDir = path.join(repoRoot, '.cursor');
    const hooksDir = path.join(cursorDir, 'hooks');
    const belayDir = path.join(cursorDir, 'belay');
    const runtimeDir = path.join(belayDir, 'runtime');
    const skillsDir = path.join(cursorDir, 'skills', 'belay');
    const commandsDir = path.join(cursorDir, 'commands');
    const hooksPath = path.join(cursorDir, 'hooks.json');
    const hooksFile = await loadHooksFile(hooksPath);
    const merged = mergeHooksFile(hooksFile);
    await ensureDir(hooksDir);
    await ensureDir(runtimeDir);
    await ensureDir(belayDir);
    await writeTextFile(path.join(cursorDir, 'belay.config.json'), renderConfig(DEFAULT_CONFIG));
    await writeTextFile(path.join(hooksDir, 'belay-before-submit.mjs'), renderBeforeSubmitHook());
    await writeTextFile(path.join(hooksDir, 'belay-shell-gate.mjs'), renderShellGateHook());
    await writeTextFile(path.join(hooksDir, 'belay-tool-gate.mjs'), renderToolGateHook());
    await writeTextFile(path.join(hooksDir, 'belay-audit.mjs'), renderAuditHook());
    await writeTextFile(path.join(runtimeDir, 'core.mjs'), renderRuntimeCore(DEFAULT_CONFIG));
    await writeTextFile(path.join(hooksDir, 'belay-runner'), buildRunnerScript(process.execPath), true);
    await writeTextFile(path.join(hooksDir, 'belay-runner.cmd'), buildWindowsRunnerScript(process.execPath));
    await writeJsonIfMissing(path.join(belayDir, 'pending-approvals.json'), EMPTY_APPROVALS);
    await writeJsonIfMissing(path.join(belayDir, 'approved-approvals.json'), EMPTY_APPROVALS);
    await writeTextIfMissing(path.join(belayDir, 'audit.ndjson'), '');
    if (nightly) {
        await ensureDir(skillsDir);
        await ensureDir(commandsDir);
        await writeTextFile(path.join(skillsDir, 'SKILL.md'), renderNightlySkill());
        await writeTextFile(path.join(commandsDir, 'belay-approve.md'), renderNightlyCommand());
    }
    await writeFile(hooksPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return { repoRoot, nightly };
}
export { loadHooksFile, mergeHooksFile };
