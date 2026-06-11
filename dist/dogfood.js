import path from 'node:path';
import { loadConfigFile, writeConfigFile } from './config-io.js';
import { mergeConfig } from './core/config.js';
import { metricsProject } from './metrics.js';
import { isDogfoodConfig, loadOperationalInsights } from './operational-insights.js';
export async function dogfoodProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json');
    if (options.enforce) {
        return promoteDogfoodToEnforce(repoRoot, configPath, options.force === true);
    }
    const existing = await loadConfigFile(repoRoot);
    const spikeOnPrompt = options.spikeOnPrompt !== false;
    const updated = mergeConfig({
        ...existing,
        mode: 'audit',
        policy: {
            ...existing.policy,
            unknownLocalEffect: 'deny',
        },
        controlPlane: {
            ...existing.controlPlane,
            spikeOnPrompt,
        },
    });
    await writeConfigFile(repoRoot, updated);
    return {
        ok: true,
        repoRoot,
        configPath,
        mode: updated.mode,
        unknownLocalEffect: updated.policy.unknownLocalEffect,
        spikeOnPrompt: updated.controlPlane.spikeOnPrompt === true,
        message: [
            'Dogfood mode enabled: audit + policy.unknownLocalEffect deny.',
            spikeOnPrompt
                ? 'OQ3 spikeOnPrompt is enabled — submit a chat prompt in Cursor to validate control-plane access.'
                : 'OQ3 spikeOnPrompt is disabled.',
            'Run agent-belay metrics after normal agent work, then agent-belay dogfood --enforce when ready.',
        ].join(' '),
    };
}
async function promoteDogfoodToEnforce(repoRoot, configPath, force) {
    const existing = await loadConfigFile(repoRoot);
    const metrics = await metricsProject({ targetDir: repoRoot });
    if (!force && !metrics.dogfood.readyForEnforce) {
        return {
            ok: false,
            repoRoot,
            configPath,
            mode: existing.mode,
            unknownLocalEffect: existing.policy.unknownLocalEffect,
            spikeOnPrompt: existing.controlPlane.spikeOnPrompt === true,
            message: [
                'Dogfood metrics do not recommend enforce yet.',
                ...metrics.dogfood.notes,
                'Re-run agent-belay metrics, tune overrides.allow, or pass --force to override.',
            ].join(' '),
        };
    }
    const updated = mergeConfig({
        ...existing,
        mode: 'enforce',
        controlPlane: {
            ...existing.controlPlane,
            spikeOnPrompt: false,
        },
    });
    await writeConfigFile(repoRoot, updated);
    return {
        ok: true,
        repoRoot,
        configPath,
        mode: updated.mode,
        unknownLocalEffect: updated.policy.unknownLocalEffect,
        spikeOnPrompt: false,
        message: force
            ? 'Switched to enforce mode (forced). Fail-closed shell policy remains active via policy.unknownLocalEffect deny.'
            : 'Switched to enforce mode. Fail-closed shell policy remains active via policy.unknownLocalEffect deny.',
    };
}
export function formatDogfoodResult(result) {
    return `${result.message}\n`;
}
export async function formatOperationalInsights(insights) {
    const lines = [
        `Dogfood: ${insights.dogfood.active ? 'active' : 'inactive'} (mode=${insights.dogfood.mode}, unknownLocalEffect=${insights.dogfood.unknownLocalEffect})`,
        `OQ3 spikeOnPrompt: ${insights.dogfood.spikeOnPrompt ? 'enabled' : 'disabled'}`,
        `Metrics: ${insights.dogfood.gateEvents} gate events, ${insights.dogfood.wouldBlockCount} would-block (${(insights.dogfood.wouldBlockRate * 100).toFixed(1)}%)`,
        `Ready for enforce: ${insights.dogfood.readyForEnforce ? 'yes' : 'not yet'}`,
    ];
    if (insights.oq3Spike) {
        lines.push(`OQ3 spike: ${insights.oq3Spike.ok ? 'ok' : 'failed'} at ${insights.oq3Spike.path}${insights.oq3Spike.recordedAt ? ` (${insights.oq3Spike.recordedAt})` : ''}`);
        if (insights.oq3Spike.error) {
            lines.push(`OQ3 error: ${insights.oq3Spike.error}`);
        }
    }
    else if (insights.dogfood.spikeOnPrompt) {
        lines.push('OQ3 spike: no oq3-spike-last.json yet — submit a chat prompt in Cursor.');
    }
    else {
        lines.push('OQ3 spike: not configured (enable spikeOnPrompt or agent-belay dogfood).');
    }
    if (insights.dogfood.notes.length > 0) {
        lines.push('', 'Dogfood notes:');
        for (const note of insights.dogfood.notes) {
            lines.push(`- ${note}`);
        }
    }
    return `${lines.join('\n')}\n`;
}
export { isDogfoodConfig, loadOperationalInsights };
