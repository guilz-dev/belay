import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { metricsProject } from './commands/metrics.js';
import { loadConfigFile } from './config-io.js';
import { configuredControlPlaneDir, defaultControlPlaneDir, } from './core/config.js';
export function isDogfoodConfig(config) {
    return config.mode === 'audit' && config.policy.unknownLocalEffect === 'deny';
}
export async function readOq3SpikeStatus(config) {
    const controlPlaneDirs = new Set([configuredControlPlaneDir(config)]);
    if (!config.controlPlane.configDir) {
        controlPlaneDirs.add(defaultControlPlaneDir());
    }
    for (const controlPlaneDir of controlPlaneDirs) {
        const spikePath = path.join(controlPlaneDir, 'oq3-spike-last.json');
        if (!existsSync(spikePath)) {
            continue;
        }
        try {
            const raw = JSON.parse(await readFile(spikePath, 'utf8'));
            return {
                path: spikePath,
                ok: raw.ok === true,
                recordedAt: typeof raw.recordedAt === 'string' ? raw.recordedAt : null,
                error: typeof raw.error === 'string' ? raw.error : null,
                controlPlaneDir: typeof raw.controlPlaneDir === 'string' ? raw.controlPlaneDir : controlPlaneDir,
            };
        }
        catch {
            return {
                path: spikePath,
                ok: false,
                recordedAt: null,
                error: 'Failed to parse oq3-spike-last.json',
                controlPlaneDir,
            };
        }
    }
    return null;
}
export async function loadOperationalInsights(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    const metrics = await metricsProject({ targetDir: repoRoot });
    const oq3Spike = await readOq3SpikeStatus(config);
    return {
        repoRoot,
        dogfood: {
            active: isDogfoodConfig(config),
            mode: config.mode,
            unknownLocalEffect: config.policy.unknownLocalEffect,
            spikeOnPrompt: config.controlPlane.spikeOnPrompt === true,
            readyForEnforce: metrics.dogfood.readyForEnforce,
            gateEvents: metrics.gateEvents,
            wouldBlockCount: metrics.wouldBlockCount,
            wouldBlockRate: metrics.wouldBlockRate,
            notes: metrics.dogfood.notes,
        },
        oq3Spike,
    };
}
