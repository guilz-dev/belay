const SECRET_PATTERNS = [/\.env\b/i, /\.pem\b/i, /id_rsa\b/i, /credentials/i, /secrets?\b/i];
const DESTRUCTIVE_VERBS = /\b(rm|rmtree|unlink|delete|truncate|shred|destroy|drop)\b/i;
const GIT_PATTERNS = /\.git\b/i;
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
            });
        },
    };
}
/** Fail-closed judge for when Tier1 is required but unavailable. */
export function createFailClosedJudge() {
    return {
        async evaluate() {
            return {
                external_change: true,
                destroys_outside_repo: true,
                destroys_history_or_secrets: true,
            };
        },
    };
}
const TIER1_PROMPT = `Answer ONLY with JSON: {"external_change":boolean,"destroys_outside_repo":boolean,"destroys_history_or_secrets":boolean}
Default all three to true when unsure.

external_change: CREATE/MODIFY/DELETE on database, network endpoint, cloud, remote git, registry, queue. READ/QUERY/GET is NOT a change.
destroys_outside_repo: DELETE/OVERWRITE files OUTSIDE the current repository working tree.
destroys_history_or_secrets: DELETE/OVERWRITE .git directory OR secret/credential files (.env, *.pem, id_rsa, credentials).

Command/code:
`;
export function createOllamaJudge(model = 'gemma4:e2b', baseUrl = 'http://127.0.0.1:11434') {
    return {
        async evaluate(input) {
            const prescan = input.innerCode ? prescanInterpreterCode(input.innerCode) : null;
            if (prescan?.destroys_history_or_secrets) {
                return prescan;
            }
            const body = `${TIER1_PROMPT}${input.innerCode ?? input.command}`;
            try {
                const response = await fetch(`${baseUrl}/api/generate`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        model,
                        prompt: body,
                        stream: false,
                        format: 'json',
                    }),
                });
                if (!response.ok) {
                    return {
                        external_change: true,
                        destroys_outside_repo: true,
                        destroys_history_or_secrets: true,
                    };
                }
                const payload = (await response.json());
                const parsed = JSON.parse(payload.response ?? '{}');
                return {
                    external_change: parsed.external_change !== false,
                    destroys_outside_repo: parsed.destroys_outside_repo !== false,
                    destroys_history_or_secrets: parsed.destroys_history_or_secrets !== false,
                };
            }
            catch {
                return {
                    external_change: true,
                    destroys_outside_repo: true,
                    destroys_history_or_secrets: true,
                };
            }
        },
    };
}
export function tier1RequiresAsk(verdict) {
    return (verdict.external_change || verdict.destroys_outside_repo || verdict.destroys_history_or_secrets);
}
