import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { belayStateDir, loadApprovalState, loadConfigFile, repoLocalStateDirFor, } from './config-io.js';
import { scrubOptionsFromConfig } from './core/config.js';
import { createEgressApprovalStore, clearEgressDaemonState, writeEgressDaemonState } from './egress-service.js';
import { startEgressProxy as bindEgressProxy } from './core/egress/proxy-server.js';
import { scrubValue } from './core/scrub.js';
async function main() {
    const repoRoot = process.env.BELAY_EGRESS_REPO_ROOT;
    if (!repoRoot) {
        process.stderr.write('BELAY_EGRESS_REPO_ROOT is required.\n');
        process.exitCode = 1;
        return;
    }
    const config = await loadConfigFile(repoRoot);
    if (!config.egress.enabled) {
        process.stderr.write('egress.enabled is false; refusing to start daemon.\n');
        process.exitCode = 1;
        return;
    }
    const store = createEgressApprovalStore(repoRoot, config);
    const stateDir = belayStateDir(config, repoLocalStateDirFor(repoRoot, config));
    const auditPath = path.join(repoRoot, config.audit.logPath);
    const { server, host, port } = await bindEgressProxy({
        config,
        repoRoot,
        store,
        async loadApproved() {
            return loadApprovalState(repoRoot, 'approved-approvals.json', config);
        },
        async onAudit(event) {
            await mkdir(path.dirname(auditPath), { recursive: true });
            const record = { timestamp: new Date().toISOString(), ...event };
            const scrubbed = scrubValue(record, scrubOptionsFromConfig(config));
            await writeFile(auditPath, `${JSON.stringify(scrubbed)}\n`, { encoding: 'utf8', flag: 'a' });
        },
    });
    await writeEgressDaemonState({ stateDir, pid: process.pid, host, port });
    const shutdown = async () => {
        server.close();
        await clearEgressDaemonState(stateDir);
        process.exit(0);
    };
    process.on('SIGTERM', () => {
        void shutdown();
    });
    process.on('SIGINT', () => {
        void shutdown();
    });
    process.stdout.write(`egress proxy listening on ${host}:${port} for ${repoRoot}\n`);
}
await main();
