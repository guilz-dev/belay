import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedApprovalsPath, belayStateDir, loadApprovalState, loadConfigFile, pendingApprovalsPath, repoLocalStateDirFor, } from './config-io.js';
import { egressAllowlistPath } from './core/egress/allowlist.js';
import { formatProxyEnv, recommendedProxyEnv } from './core/egress/env.js';
function egressStatePaths(repoRoot, config) {
    const stateDir = belayStateDir(config, repoLocalStateDirFor(repoRoot, config));
    return {
        stateDir,
        pidPath: path.join(stateDir, 'egress-proxy.pid'),
        statusPath: path.join(stateDir, 'egress-proxy.json'),
    };
}
function daemonScriptPath() {
    return fileURLToPath(new URL('./egress-daemon.js', import.meta.url));
}
async function readStatusFile(statusPath) {
    if (!existsSync(statusPath)) {
        return null;
    }
    try {
        const raw = JSON.parse(await readFile(statusPath, 'utf8'));
        if (typeof raw.pid !== 'number') {
            return null;
        }
        return {
            pid: raw.pid,
            host: raw.host ?? '127.0.0.1',
            port: raw.port ?? 17831,
            startedAt: raw.startedAt ?? '',
        };
    }
    catch {
        return null;
    }
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export async function egressStatus(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    const { statusPath } = egressStatePaths(repoRoot, config);
    const status = await readStatusFile(statusPath);
    const running = status ? isProcessAlive(status.pid) : false;
    return {
        repoRoot,
        enabled: config.egress.enabled,
        running,
        host: status?.host ?? config.egress.listenHost,
        port: status?.port ?? config.egress.listenPort,
        pid: running ? (status?.pid ?? null) : null,
        startedAt: running ? (status?.startedAt ?? null) : null,
        proxyEnv: recommendedProxyEnv(config.egress),
    };
}
export async function startEgressProxy(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    if (!config.egress.enabled) {
        return {
            ok: false,
            message: 'Egress proxy is disabled in config. Set egress.enabled to true first.',
        };
    }
    const current = await egressStatus({ targetDir: repoRoot });
    if (current.running) {
        return {
            ok: true,
            message: `Egress proxy already running (pid ${current.pid}) at ${current.host}:${current.port}.`,
        };
    }
    const { stateDir } = egressStatePaths(repoRoot, config);
    await mkdir(stateDir, { recursive: true });
    const child = spawn(process.execPath, [daemonScriptPath()], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            BELAY_EGRESS_REPO_ROOT: repoRoot,
        },
    });
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await egressStatus({ targetDir: repoRoot });
    if (!after.running) {
        return {
            ok: false,
            message: 'Failed to start egress proxy. Check that the listen port is free.',
        };
    }
    return {
        ok: true,
        message: `Egress proxy started (pid ${after.pid}) at ${after.host}:${after.port}.`,
    };
}
export async function stopEgressProxy(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    const { pidPath, statusPath } = egressStatePaths(repoRoot, config);
    const status = await readStatusFile(statusPath);
    if (!status || !isProcessAlive(status.pid)) {
        if (existsSync(pidPath)) {
            await unlink(pidPath).catch(() => undefined);
        }
        if (existsSync(statusPath)) {
            await unlink(statusPath).catch(() => undefined);
        }
        return { ok: true, message: 'Egress proxy is not running.' };
    }
    try {
        process.kill(status.pid, 'SIGTERM');
    }
    catch {
        return { ok: false, message: `Failed to stop egress proxy (pid ${status.pid}).` };
    }
    await unlink(pidPath).catch(() => undefined);
    await unlink(statusPath).catch(() => undefined);
    return { ok: true, message: `Stopped egress proxy (pid ${status.pid}).` };
}
export async function egressEnv(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    if (!config.egress.enabled) {
        return {
            ok: false,
            message: 'Egress proxy is disabled in config.',
            env: {},
        };
    }
    const env = recommendedProxyEnv(config.egress);
    return {
        ok: true,
        message: formatProxyEnv(config.egress),
        env,
    };
}
export function formatEgressStatusReport(report) {
    const lines = [
        `agent-belay egress status for ${report.repoRoot}`,
        `Config enabled: ${report.enabled ? 'yes' : 'no'}`,
        `Running: ${report.running ? 'yes' : 'no'}`,
        `Listen: ${report.host}:${report.port}`,
    ];
    if (report.pid) {
        lines.push(`PID: ${report.pid}`);
    }
    if (report.startedAt) {
        lines.push(`Started: ${report.startedAt}`);
    }
    lines.push('', 'Recommended proxy environment:');
    for (const [key, value] of Object.entries(report.proxyEnv)) {
        lines.push(`  ${key}=${value}`);
    }
    return `${lines.join('\n')}\n`;
}
export function createEgressApprovalStore(repoRoot, config) {
    const repoLocalDir = repoLocalStateDirFor(repoRoot, config);
    return {
        allowlistPath: egressAllowlistPath(config, repoLocalDir),
        async loadPending() {
            const filePath = pendingApprovalsPath(repoRoot, config);
            return { filePath, state: await loadApprovalState(repoRoot, 'pending-approvals.json', config) };
        },
        async loadApproved() {
            const filePath = approvedApprovalsPath(repoRoot, config);
            return { filePath, state: await loadApprovalState(repoRoot, 'approved-approvals.json', config) };
        },
        async writePending(_filePath, state) {
            const { saveApprovalState } = await import('./config-io.js');
            await saveApprovalState(repoRoot, 'pending-approvals.json', state, config);
        },
        async writeApproved(_filePath, state) {
            const { saveApprovalState } = await import('./config-io.js');
            await saveApprovalState(repoRoot, 'approved-approvals.json', state, config);
        },
    };
}
export async function writeEgressDaemonState(params) {
    await mkdir(params.stateDir, { recursive: true });
    const startedAt = new Date().toISOString();
    await writeFile(path.join(params.stateDir, 'egress-proxy.pid'), `${params.pid}\n`, 'utf8');
    await writeFile(path.join(params.stateDir, 'egress-proxy.json'), `${JSON.stringify({ pid: params.pid, host: params.host, port: params.port, startedAt }, null, 2)}\n`, 'utf8');
}
export async function clearEgressDaemonState(stateDir) {
    await unlink(path.join(stateDir, 'egress-proxy.pid')).catch(() => undefined);
    await unlink(path.join(stateDir, 'egress-proxy.json')).catch(() => undefined);
}
