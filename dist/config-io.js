import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compactApprovals, isExpired, mergeApprovalStates } from './core/approval.js';
import { approvedApprovalsFile, belayStateDir, configuredControlPlaneDir, mergeConfig, pendingApprovalsFile, } from './core/config.js';
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
const APPROVAL_STATE_FILES = ['pending-approvals.json', 'approved-approvals.json'];
function approvalFilesExist(dir) {
    return APPROVAL_STATE_FILES.some((fileName) => existsSync(path.join(dir, fileName)));
}
async function repoLocalApprovalsEmpty(repoRoot) {
    const repoLocalDir = path.join(repoRoot, '.cursor', 'belay');
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
    const repoLocalDir = path.join(repoRoot, '.cursor', 'belay');
    const targetDir = belayStateDir(config, repoRoot);
    await migrateApprovalFilesBetween(repoLocalDir, targetDir);
}
export async function migrateControlPlaneApprovalsToRepoLocal(repoRoot, config, sourceDir = configuredControlPlaneDir(config)) {
    if (config.controlPlane.enabled) {
        return;
    }
    const targetDir = path.join(repoRoot, '.cursor', 'belay');
    await migrateApprovalFilesBetween(sourceDir, targetDir);
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
    if (merged.controlPlane.enabled) {
        await migrateRepoLocalApprovalsToControlPlane(repoRoot, merged);
    }
    else {
        const sourceDir = configuredControlPlaneDir(merged);
        if (approvalFilesExist(sourceDir) && (await repoLocalApprovalsEmpty(repoRoot))) {
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
