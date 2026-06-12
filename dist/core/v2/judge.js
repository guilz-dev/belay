import { scrubOutboundForJudge } from './judge-outbound.js';
const SECRET_PATTERNS = [/\.env\b/i, /\.pem\b/i, /id_rsa\b/i, /credentials/i, /secrets?\b/i];
const DESTRUCTIVE_VERBS = /\b(rm|rmtree|unlink|delete|truncate|shred|destroy|drop)\b/i;
const GIT_PATTERNS = /\.git\b/i;
const TIER1_PROMPT = `Answer ONLY with JSON: {"external_change":boolean,"destroys_outside_repo":boolean,"destroys_history_or_secrets":boolean,"reason":string}
Default all three booleans to true when unsure. reason should be a short snake_case label.

external_change: CREATE/MODIFY/DELETE on database, network endpoint, cloud, remote git, registry, queue. READ/QUERY/GET is NOT a change.
destroys_outside_repo: DELETE/OVERWRITE files OUTSIDE the current repository working tree.
destroys_history_or_secrets: DELETE/OVERWRITE .git directory OR secret/credential files (.env, *.pem, id_rsa, credentials).

Command/code:
`;
function failClosedVerdict(reason) {
    return {
        external_change: true,
        destroys_outside_repo: true,
        destroys_history_or_secrets: true,
        reason,
    };
}
function parseTier1Json(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.external_change !== 'boolean' ||
            typeof parsed.destroys_outside_repo !== 'boolean' ||
            typeof parsed.destroys_history_or_secrets !== 'boolean') {
            return null;
        }
        return {
            external_change: parsed.external_change !== false,
            destroys_outside_repo: parsed.destroys_outside_repo !== false,
            destroys_history_or_secrets: parsed.destroys_history_or_secrets !== false,
            reason: typeof parsed.reason === 'string' ? parsed.reason : 'tier1_llm',
        };
    }
    catch {
        return null;
    }
}
export function prescanInterpreterCode(code) {
    const normalized = code.replaceAll('\\', '/');
    const hitsSecret = SECRET_PATTERNS.some((pattern) => pattern.test(normalized));
    const hitsGit = GIT_PATTERNS.test(normalized);
    const hitsDestructive = DESTRUCTIVE_VERBS.test(normalized);
    if ((hitsSecret || hitsGit) && hitsDestructive) {
        return {
            external_change: false,
            destroys_outside_repo: false,
            destroys_history_or_secrets: true,
            reason: 'prescan_destructive_secret',
        };
    }
    return null;
}
/** Conservative stub: Tier1 defers to Tier0; returns safe negatives for structural suite. */
export function createDeterministicJudgeStub() {
    return {
        evaluate() {
            return Promise.resolve({
                external_change: false,
                destroys_outside_repo: false,
                destroys_history_or_secrets: false,
                reason: 'deterministic_stub',
            });
        },
    };
}
/** Fail-closed judge for when Tier1 is required but unavailable. */
export function createFailClosedJudge() {
    return {
        evaluate() {
            return Promise.resolve(failClosedVerdict('fail_closed'));
        },
    };
}
export function createOllamaJudge(options = {}) {
    const model = options.model ?? 'gemma4:e2b';
    const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    const timeoutMs = options.timeoutMs ?? 25000;
    const fetchImpl = options.fetchImpl ?? fetch;
    const judge = {
        async evaluate(input) {
            const started = Date.now();
            const prescan = input.innerCode ? prescanInterpreterCode(input.innerCode) : null;
            if (prescan?.destroys_history_or_secrets) {
                judge.lastTrace = {
                    provider: 'ollama',
                    modelRequested: model,
                    modelResolved: model,
                    latencyMs: Date.now() - started,
                };
                return prescan;
            }
            const body = `${TIER1_PROMPT}${input.text}`;
            try {
                const response = await fetchImpl(`${baseUrl}/api/generate`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        model,
                        prompt: body,
                        stream: false,
                        format: 'json',
                        keep_alive: options.keepAlive ?? undefined,
                    }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (!response.ok) {
                    judge.lastTrace = {
                        provider: 'fallback',
                        modelRequested: model,
                        modelResolved: model,
                        latencyMs: Date.now() - started,
                        fallbackReason: `ollama_http_${response.status}`,
                    };
                    return failClosedVerdict('ollama_unavailable');
                }
                const payload = (await response.json());
                const parsed = parseTier1Json(payload.response ?? '{}');
                if (!parsed) {
                    judge.lastTrace = {
                        provider: 'fallback',
                        modelRequested: model,
                        modelResolved: model,
                        latencyMs: Date.now() - started,
                        fallbackReason: 'ollama_parse_error',
                    };
                    return failClosedVerdict('ollama_parse_error');
                }
                judge.lastTrace = {
                    provider: 'ollama',
                    modelRequested: model,
                    modelResolved: model,
                    latencyMs: Date.now() - started,
                };
                return parsed;
            }
            catch (error) {
                judge.lastTrace = {
                    provider: 'fallback',
                    modelRequested: model,
                    modelResolved: model,
                    latencyMs: Date.now() - started,
                    fallbackReason: error instanceof Error ? error.message : 'ollama_error',
                };
                return failClosedVerdict('ollama_unavailable');
            }
        },
    };
    return judge;
}
const DEFAULT_CURSOR_API_BASE = `https://api.${'cursor'}.com/v1`;
export function createCursorJudge(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const apiBase = (options.endpoint ??
        process.env.CURSOR_API_BASE ??
        DEFAULT_CURSOR_API_BASE).replace(/\/$/, '');
    const judge = {
        async evaluate(input) {
            const started = Date.now();
            const prescan = input.innerCode ? prescanInterpreterCode(input.innerCode) : null;
            if (prescan?.destroys_history_or_secrets) {
                judge.lastTrace = {
                    provider: 'cursor',
                    modelRequested: options.modelRequested,
                    modelResolved: options.modelResolved,
                    latencyMs: Date.now() - started,
                };
                return prescan;
            }
            const scrubbed = scrubOutboundForJudge(input.text, {
                sensitivePaths: options.sensitivePaths,
                scrubOptions: options.scrubOptions,
            });
            if (!scrubbed.ok) {
                judge.lastTrace = {
                    provider: 'fallback',
                    modelRequested: options.modelRequested,
                    modelResolved: options.modelResolved,
                    latencyMs: Date.now() - started,
                    fallbackReason: scrubbed.reason,
                };
                return failClosedVerdict('outbound_scrub_failed');
            }
            const apiKey = options.apiKey ?? process.env.CURSOR_API_KEY?.trim();
            if (!apiKey) {
                judge.lastTrace = {
                    provider: 'fallback',
                    modelRequested: options.modelRequested,
                    modelResolved: options.modelResolved,
                    latencyMs: Date.now() - started,
                    fallbackReason: 'missing_api_key',
                };
                return failClosedVerdict('cursor_auth_error');
            }
            const prompt = `${TIER1_PROMPT}${scrubbed.text}`;
            try {
                const response = await fetchImpl(`${apiBase}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                        model: options.modelResolved,
                        messages: [{ role: 'user', content: prompt }],
                        response_format: { type: 'json_object' },
                    }),
                    signal: AbortSignal.timeout(options.timeoutMs),
                });
                if (!response.ok) {
                    judge.lastTrace = {
                        provider: 'fallback',
                        modelRequested: options.modelRequested,
                        modelResolved: options.modelResolved,
                        latencyMs: Date.now() - started,
                        fallbackReason: `cursor_http_${response.status}`,
                    };
                    return failClosedVerdict('cursor_unavailable');
                }
                const payload = (await response.json());
                const content = payload.choices?.[0]?.message?.content ?? '{}';
                const parsed = parseTier1Json(content);
                judge.lastTrace = {
                    provider: parsed ? 'cursor' : 'fallback',
                    modelRequested: options.modelRequested,
                    modelResolved: options.modelResolved,
                    latencyMs: Date.now() - started,
                    outboundRedacted: true,
                    fallbackReason: parsed ? undefined : 'cursor_parse_error',
                };
                return parsed ?? failClosedVerdict('cursor_parse_error');
            }
            catch (error) {
                judge.lastTrace = {
                    provider: 'fallback',
                    modelRequested: options.modelRequested,
                    modelResolved: options.modelResolved,
                    latencyMs: Date.now() - started,
                    fallbackReason: error instanceof Error ? error.message : 'cursor_error',
                };
                return failClosedVerdict('cursor_unavailable');
            }
        },
    };
    return judge;
}
export function tier1RequiresAsk(verdict) {
    return (verdict.external_change || verdict.destroys_outside_repo || verdict.destroys_history_or_secrets);
}
