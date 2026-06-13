import path from 'node:path';
import { configPathFor, loadConfigFile, writeConfigFile } from '../config-io.js';
import { mergeConfig } from '../core/config.js';
import { isDogfoodConfig, loadOperationalInsights } from '../operational-insights.js';
import { metricsProject } from './metrics.js';
export async function dogfoodProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const adapter = options.adapter ?? 'cursor';
    const configPath = configPathFor(repoRoot, adapter);
    if (options.enforce) {
        return promoteDogfoodToEnforce(repoRoot, configPath, options.force === true, adapter);
    }
    const existing = await loadConfigFile(repoRoot, adapter);
    const updated = mergeConfig({
        ...existing,
        mode: 'audit',
        policy: {
            ...existing.policy,
            unknownLocalEffect: 'deny',
        },
    });
    await writeConfigFile(repoRoot, updated, adapter);
    return {
        ok: true,
        repoRoot,
        configPath,
        mode: updated.mode,
        unknownLocalEffect: updated.policy.unknownLocalEffect,
        message: [
            'Dogfood mode enabled: audit + policy.unknownLocalEffect deny.',
            'Run agent-belay metrics after normal agent work, then agent-belay dogfood --enforce when ready.',
        ].join(' '),
    };
}
async function promoteDogfoodToEnforce(repoRoot, configPath, force, adapter = 'cursor') {
    const existing = await loadConfigFile(repoRoot, adapter);
    const metrics = await metricsProject({ targetDir: repoRoot });
    if (!force && !metrics.dogfood.readyForEnforce) {
        return {
            ok: false,
            repoRoot,
            configPath,
            mode: existing.mode,
            unknownLocalEffect: existing.policy.unknownLocalEffect,
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
    });
    await writeConfigFile(repoRoot, updated, adapter);
    return {
        ok: true,
        repoRoot,
        configPath,
        mode: updated.mode,
        unknownLocalEffect: updated.policy.unknownLocalEffect,
        message: force
            ? 'Switched to enforce mode (forced). Fail-closed shell policy remains active via policy.unknownLocalEffect deny.'
            : 'Switched to enforce mode. Fail-closed shell policy remains active via policy.unknownLocalEffect deny.',
    };
}
export function formatDogfoodResult(result) {
    return `${result.message}\n`;
}
export { isDogfoodConfig, loadOperationalInsights };
