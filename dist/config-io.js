import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAdapterLayout } from './adapters/layouts/index.js';
import { compactApprovals, isExpired, mergeApprovalStates } from './core/approval.js';
import { approvedApprovalsFile, belayStateDir, configuredControlPlaneDir, mergeConfig, pendingApprovalsFile, } from './core/config.js';
import { resolveLayeredConfig, teamConfigPath, } from './core/config-layers.js';
export function resolveAdapterName(config) {
    return config.adapter === 'claude' ? 'claude' : 'cursor';
}
export function detectAdapterName(repoRoot) {
    if (existsSync(configPathFor(repoRoot, 'claude'))) {
        return 'claude';
    }
    return 'cursor';
}
export function configPathFor(repoRoot, adapter = 'cursor') {
    return getAdapterLayout(adapter).configPath(repoRoot);
}
export function repoLocalStateDirFor(repoRoot, config) {
    return getAdapterLayout(resolveAdapterName(config)).repoLocalStateDir(repoRoot);
}
export function runtimeCorePath(repoRoot, adapter = 'cursor') {
    const layout = getAdapterLayout(adapter);
    return path.join(layout.runtimeDir(repoRoot), 'core.mjs');
}
export function pendingApprovalsPath(repoRoot, config) {
    return pendingApprovalsFile(config, repoLocalStateDirFor(repoRoot, config));
}
export function approvedApprovalsPath(repoRoot, config) {
    return approvedApprovalsFile(config, repoLocalStateDirFor(repoRoot, config));
}
export { belayStateDir };
export async function ensureBelayStateDir(config, repoRoot) {
    const stateDir = belayStateDir(config, repoLocalStateDirFor(repoRoot, config));
    await mkdir(stateDir, { recursive: true });
    return stateDir;
}
const APPROVAL_STATE_FILES = ['pending-approvals.json', 'approved-approvals.json'];
function approvalFilesExist(dir) {
    return APPROVAL_STATE_FILES.some((fileName) => existsSync(path.join(dir, fileName)));
}
async function repoLocalApprovalsEmpty(repoRoot, config) {
    const repoLocalDir = repoLocalStateDirFor(repoRoot, config);
    if (!approvalFilesExist(repoLocalDir)) {
        return true;
    }
    for (const fileName of APPROVAL_STATE_FILES) {
        const filePath = path.join(repoLocalDir, fileName);
        if (!existsSync(filePath)) {
            continue;
        }
        const state = await readApprovalStateFile(filePath);
        if (state.approvals.length > 0) {
            return false;
        }
    }
    return true;
}
async function readApprovalStateFile(filePath) {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
        version: 1,
        approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
    };
}
async function writeApprovalStateFile(filePath, state) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(compactApprovals(state), null, 2)}\n`, 'utf8');
}
async function migrateApprovalFilesBetween(sourceDir, targetDir) {
    await mkdir(targetDir, { recursive: true });
    for (const fileName of APPROVAL_STATE_FILES) {
        const from = path.join(sourceDir, fileName);
        const to = path.join(targetDir, fileName);
        if (!existsSync(from)) {
            continue;
        }
        if (!existsSync(to)) {
            await copyFile(from, to);
            continue;
        }
        const targetState = await readApprovalStateFile(to);
        const sourceState = await readApprovalStateFile(from);
        await writeApprovalStateFile(to, mergeApprovalStates(targetState, sourceState));
    }
}
export async function migrateRepoLocalApprovalsToControlPlane(repoRoot, config) {
    if (!config.controlPlane.enabled) {
        return;
    }
    const repoLocalDir = repoLocalStateDirFor(repoRoot, config);
    const targetDir = belayStateDir(config, repoLocalDir);
    await migrateApprovalFilesBetween(repoLocalDir, targetDir);
}
export async function migrateControlPlaneApprovalsToRepoLocal(repoRoot, config, sourceDir = configuredControlPlaneDir(config)) {
    if (config.controlPlane.enabled) {
        return;
    }
    const targetDir = repoLocalStateDirFor(repoRoot, config);
    await migrateApprovalFilesBetween(sourceDir, targetDir);
}
export async function loadLayeredConfig(repoRoot, adapter = detectAdapterName(repoRoot)) {
    const layout = getAdapterLayout(adapter);
    const configPath = configPathFor(repoRoot, adapter);
    let repoConfig = {};
    if (existsSync(configPath)) {
        repoConfig = JSON.parse(await readFile(configPath, 'utf8'));
    }
    let teamConfig = null;
    const teamPath = teamConfigPath();
    if (existsSync(teamPath)) {
        teamConfig = JSON.parse(await readFile(teamPath, 'utf8'));
    }
    return resolveLayeredConfig({
        repoConfig,
        adapterDefaults: layout.defaultConfig(repoRoot),
        teamConfig,
        teamConfigPath: teamPath,
        repoConfigPath: existsSync(configPath) ? configPath : undefined,
    });
}
export async function loadConfigFile(repoRoot, adapter = detectAdapterName(repoRoot)) {
    const layered = await loadLayeredConfig(repoRoot, adapter);
    return layered.config;
}
export async function writeConfigFile(repoRoot, config, adapter = resolveAdapterName(config)) {
    const configPath = configPathFor(repoRoot, adapter);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
export async function mergeAndWriteConfig(repoRoot, adapter = 'cursor') {
    const layout = getAdapterLayout(adapter);
    const configPath = layout.configPath(repoRoot);
    let existing = {};
    if (existsSync(configPath)) {
        existing = JSON.parse(await readFile(configPath, 'utf8'));
    }
    const merged = mergeConfig(existing, layout.defaultConfig(repoRoot));
    await writeConfigFile(repoRoot, merged, adapter);
    await ensureBelayStateDir(merged, repoRoot);
    if (merged.controlPlane.enabled) {
        await migrateRepoLocalApprovalsToControlPlane(repoRoot, merged);
    }
    else {
        const sourceDir = configuredControlPlaneDir(merged);
        if (approvalFilesExist(sourceDir) && (await repoLocalApprovalsEmpty(repoRoot, merged))) {
            await migrateControlPlaneApprovalsToRepoLocal(repoRoot, merged, sourceDir);
        }
    }
    return merged;
}
export async function loadApprovalState(repoRoot, fileName, config) {
    const filePath = fileName === 'pending-approvals.json'
        ? pendingApprovalsPath(repoRoot, config)
        : approvedApprovalsPath(repoRoot, config);
    if (!existsSync(filePath)) {
        return { version: 1, approvals: [] };
    }
    return readApprovalStateFile(filePath);
}
export async function saveApprovalState(repoRoot, fileName, state, config) {
    const filePath = fileName === 'pending-approvals.json'
        ? pendingApprovalsPath(repoRoot, config)
        : approvedApprovalsPath(repoRoot, config);
    await writeApprovalStateFile(filePath, state);
}
export function countExpiredPending(state) {
    return state.approvals.filter((approval) => isExpired(approval)).length;
}
