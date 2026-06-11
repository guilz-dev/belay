import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedApprovalsPath, belayStateDir, loadApprovalState, loadConfigFile, pendingApprovalsPath, repoLocalStateDirFor, } from './config-io.js';
import { configuredControlPlaneDir } from './core/config.js';
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
            repoRoot: typeof raw.repoRoot === 'string' ? raw.repoRoot : undefined,
        };
    }
    catch {
        return null;
    }
}
async function isPortOpen(host, port) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        const finish = (open) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(300);
        socket.on('connect', () => finish(true));
        socket.on('timeout', () => finish(false));
        socket.on('error', () => finish(false));
    });
}
async function resolveLiveEgressStatus(repoRoot, config) {
    const { statusPath } = egressStatePaths(repoRoot, config);
    const statusCandidates = [statusPath];
    const controlPlaneStatus = path.join(configuredControlPlaneDir(config), 'egress-proxy.json');
    if (!statusCandidates.includes(controlPlaneStatus)) {
        statusCandidates.push(controlPlaneStatus);
    }
    let status = null;
    for (const candidate of statusCandidates) {
        const candidateStatus = await readStatusFile(candidate);
        if (candidateStatus && isProcessAlive(candidateStatus.pid)) {
            status = candidateStatus;
            break;
        }
    }
    const host = status?.host ?? config.egress.listenHost;
    const port = status?.port ?? config.egress.listenPort;
    const portOccupied = await isPortOpen(host, port);
    return { status, host, port, portOccupied };
}
async function waitForEgressRunning(repoRoot, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = await egressStatus({ targetDir: repoRoot });
        if (status.running && !status.foreignProxy) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
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
    const { status, host, port, portOccupied } = await resolveLiveEgressStatus(repoRoot, config);
    const ownedRunning = Boolean(status);
    const running = ownedRunning || portOccupied;
    const boundRepoRoot = status?.repoRoot ?? null;
    const foreignProxy = portOccupied && !ownedRunning;
    const repoRootMismatch = Boolean((boundRepoRoot && boundRepoRoot !== repoRoot) || foreignProxy);
    return {
        repoRoot,
        enabled: config.egress.enabled,
        running,
        host,
        port,
        pid: ownedRunning ? (status?.pid ?? null) : null,
        startedAt: ownedRunning ? (status?.startedAt ?? null) : null,
        boundRepoRoot: foreignProxy ? boundRepoRoot : boundRepoRoot,
        repoRootMismatch,
        foreignProxy,
        portOccupied,
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
    if (current.foreignProxy) {
        return {
            ok: false,
            message: `Port ${current.host}:${current.port} is already in use by another egress proxy${current.boundRepoRoot ? ` for ${current.boundRepoRoot}` : ''}. Stop it before starting for ${repoRoot}.`,
        };
    }
    if (current.running) {
        if (current.repoRootMismatch) {
            return {
                ok: false,
                message: `Egress proxy already running for ${current.boundRepoRoot} (pid ${current.pid}). Stop it before starting for ${repoRoot}.`,
            };
        }
        return {
            ok: true,
            message: `Egress proxy already running (pid ${current.pid}) at ${current.host}:${current.port} for ${current.boundRepoRoot ?? repoRoot}.`,
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
    const started = await waitForEgressRunning(repoRoot);
    const after = await egressStatus({ targetDir: repoRoot });
    if (!started || !after.running || after.foreignProxy) {
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
    const status = await egressStatus({ targetDir: repoRoot });
    if (status.foreignProxy) {
        return {
            ok: false,
            message: `Port ${status.host}:${status.port} is in use by another egress proxy${status.boundRepoRoot ? ` for ${status.boundRepoRoot}` : ''}. Do not export proxy env for ${repoRoot} until it is stopped.`,
            env: {},
        };
    }
    if (status.repoRootMismatch) {
        return {
            ok: false,
            message: `Egress proxy is bound to ${status.boundRepoRoot}, not ${repoRoot}. Stop and restart egress for this repository.`,
            env: {},
        };
    }
    if (!status.running) {
        return {
            ok: false,
            message: 'Egress proxy is not running. Run agent-belay egress start first.',
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
    if (report.boundRepoRoot) {
        lines.push(`Bound repo: ${report.boundRepoRoot}`);
    }
    if (report.foreignProxy) {
        lines.push('Warning: listen port is occupied by a proxy not owned by this repository state.');
    }
    if (report.repoRootMismatch) {
        lines.push(`Warning: proxy is bound to a different repository than ${report.repoRoot}.`);
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
    await writeFile(path.join(params.stateDir, 'egress-proxy.json'), `${JSON.stringify({ pid: params.pid, host: params.host, port: params.port, startedAt, repoRoot: params.repoRoot }, null, 2)}\n`, 'utf8');
}
export async function clearEgressDaemonState(stateDir) {
    await unlink(path.join(stateDir, 'egress-proxy.pid')).catch(() => undefined);
    await unlink(path.join(stateDir, 'egress-proxy.json')).catch(() => undefined);
}
