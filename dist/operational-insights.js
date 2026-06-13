import path from 'node:path';
import { metricsProject } from './commands/metrics.js';
import { loadConfigFile } from './config-io.js';
export function isDogfoodConfig(config) {
    return config.mode === 'audit' && config.policy.unknownLocalEffect === 'deny';
}
export async function loadOperationalInsights(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    const metrics = await metricsProject({ targetDir: repoRoot });
    return {
        repoRoot,
        dogfood: {
            active: isDogfoodConfig(config),
            mode: config.mode,
            unknownLocalEffect: config.policy.unknownLocalEffect,
            readyForEnforce: metrics.dogfood.readyForEnforce,
            gateEvents: metrics.gateEvents,
            wouldBlockCount: metrics.wouldBlockCount,
            wouldBlockRate: metrics.wouldBlockRate,
            notes: metrics.dogfood.notes,
        },
    };
}
