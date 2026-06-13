import { normalizeJudgeProvider, scrubOptionsFromConfig } from './config.js';
import { resolveJudgeApiKey } from './judge-api-key.js';
import { assertJudgeEndpoint } from './judge-config.js';
import { createOpenAiCompatibleJudge, createOllamaJudge } from './v2/judge.js';
import { loadPinnedJudgeModels, resolveCloudModel } from './v2/judge-factory.js';
export async function diagnoseJudge(config) {
    const issues = [];
    const warnings = [];
    const notes = [];
    const judge = config.judge;
    const provider = normalizeJudgeProvider(judge.provider);
    notes.push(`Judge provider: ${provider}`);
    notes.push(`Judge model requested: ${judge.model}`);
    if (config.policy.modelAssist.enabled) {
        warnings.push('policy.modelAssist is enabled but is not wired to v2 Tier1. Use top-level judge instead.');
    }
    if (provider === 'openai-compatible') {
        warnings.push('Cloud judge egress is enabled. Commands are redacted (R23) before send, but path structure and intent may still leave the repo.');
        try {
            assertJudgeEndpoint(judge);
            notes.push(`OpenAI-compatible endpoint: ${judge.endpoint}`);
        }
        catch {
            issues.push('openai-compatible judge requires judge.endpoint. No default cloud base URL is applied.');
            return { issues, warnings, notes };
        }
        const keyInfo = resolveJudgeApiKey();
        if (!keyInfo.key) {
            issues.push('BELAY_JUDGE_API_KEY / OPENAI_API_KEY is not set. Tier1 cloud judge will fail closed to ask.');
        }
        else {
            notes.push(`API key source: ${keyInfo.source}`);
        }
        const pinnedModels = await loadPinnedJudgeModels();
        const resolved = resolveCloudModel(judge.model, pinnedModels['openai-compatible']);
        notes.push(`Resolved model: ${resolved.resolved}`);
        if (keyInfo.key) {
            const traced = createOpenAiCompatibleJudge({
                endpoint: judge.endpoint,
                modelRequested: judge.model,
                modelResolved: resolved.resolved,
                timeoutMs: Math.min(judge.timeoutMs, 5000),
                apiKey: keyInfo.key,
                sensitivePaths: config.classifier.sensitivePaths,
                scrubOptions: scrubOptionsFromConfig(config),
                fetchImpl: async () => new Response(JSON.stringify({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    external_change: false,
                                    destroys_outside_repo: false,
                                    destroys_history_or_secrets: false,
                                    reason: 'doctor_dry_run',
                                }),
                            },
                        },
                    ],
                }), { status: 200 }),
            });
            const dryRun = await traced.evaluate({
                text: 'git status',
                context: { cwd: process.cwd(), repoRoot: process.cwd() },
            });
            if (dryRun.reason.startsWith('openai_compatible_') ||
                dryRun.reason === 'outbound_scrub_failed') {
                issues.push(`OpenAI-compatible judge dry-run failed: ${dryRun.reason}`);
            }
            else {
                notes.push('OpenAI-compatible judge dry-run succeeded.');
            }
        }
        return { issues, warnings, notes };
    }
    const endpoint = judge.endpoint ?? 'http://127.0.0.1:11434';
    notes.push(`Ollama endpoint: ${endpoint}`);
    try {
        const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) {
            issues.push(`Ollama endpoint unreachable (HTTP ${response.status}). Tier1 will fail closed.`);
        }
        else {
            const tags = (await response.json());
            const names = (tags.models ?? []).map((entry) => entry.name ?? '');
            const hasModel = names.some((name) => name === judge.model || name.startsWith(`${judge.model}:`));
            if (!hasModel) {
                issues.push(`Ollama model "${judge.model}" is not present. Pull it before enforce mode.`);
            }
            else {
                notes.push(`Ollama model "${judge.model}" is available.`);
            }
        }
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : 'connection failed';
        issues.push(`Ollama endpoint unreachable (${detail}). Tier1 will fail closed.`);
    }
    const warm = createOllamaJudge({
        model: judge.model,
        baseUrl: endpoint,
        timeoutMs: Math.min(judge.timeoutMs, 5000),
        fetchImpl: async () => new Response(JSON.stringify({
            response: JSON.stringify({
                external_change: false,
                destroys_outside_repo: false,
                destroys_history_or_secrets: false,
                reason: 'doctor_warm',
            }),
        }), { status: 200 }),
    });
    const warmResult = await warm.evaluate({
        text: 'git status',
        context: { cwd: process.cwd(), repoRoot: process.cwd() },
    });
    if (warmResult.reason === 'ollama_unavailable' || warmResult.reason === 'ollama_parse_error') {
        issues.push(`Ollama warm call failed: ${warmResult.reason}`);
    }
    else {
        notes.push('Ollama warm call succeeded.');
    }
    return { issues, warnings, notes };
}
