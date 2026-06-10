import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compactApprovals, isExpired } from './core/approval.js';
import { approvedApprovalsFile, belayStateDir, mergeConfig, pendingApprovalsFile, } from './core/config.js';
import { DEFAULT_CONFIG } from './defaults.js';
export function configPathFor(repoRoot) {
    return path.join(repoRoot, '.cursor', 'belay.config.json');
}
export { belayStateDir };
export function pendingApprovalsPath(repoRoot, config) {
    return pendingApprovalsFile(config, repoRoot);
}
export function approvedApprovalsPath(repoRoot, config) {
    return approvedApprovalsFile(config, repoRoot);
}
export function runtimeCorePath(repoRoot) {
    return path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs');
}
export async function ensureBelayStateDir(config, repoRoot) {
    const stateDir = belayStateDir(config, repoRoot);
    await mkdir(stateDir, { recursive: true });
    return stateDir;
}
export async function loadConfigFile(repoRoot) {
    const configPath = configPathFor(repoRoot);
    if (!existsSync(configPath)) {
        return { ...DEFAULT_CONFIG };
    }
    const raw = await readFile(configPath, 'utf8');
    return mergeConfig(JSON.parse(raw));
}
export async function writeConfigFile(repoRoot, config) {
    await writeFile(configPathFor(repoRoot), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
export async function mergeAndWriteConfig(repoRoot) {
    const configPath = configPathFor(repoRoot);
    let existing = {};
    if (existsSync(configPath)) {
        existing = JSON.parse(await readFile(configPath, 'utf8'));
    }
    const merged = mergeConfig(existing);
    await writeConfigFile(repoRoot, merged);
    await ensureBelayStateDir(merged, repoRoot);
    return merged;
}
export async function loadApprovalState(repoRoot, fileName, config) {
    const filePath = fileName === 'pending-approvals.json'
        ? pendingApprovalsPath(repoRoot, config)
        : approvedApprovalsPath(repoRoot, config);
    if (!existsSync(filePath)) {
        return { version: 1, approvals: [] };
    }
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
        version: 1,
        approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
    };
}
export async function saveApprovalState(repoRoot, fileName, state, config) {
    const filePath = fileName === 'pending-approvals.json'
        ? pendingApprovalsPath(repoRoot, config)
        : approvedApprovalsPath(repoRoot, config);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(compactApprovals(state), null, 2)}\n`, 'utf8');
}
export function countExpiredPending(state) {
    return state.approvals.filter((approval) => isExpired(approval)).length;
}
