const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
/**
 * Optional LLM assist for ambiguous middle band. Default off; failures degrade to heuristic.
 */
export async function maybeAssistAssessment(input, config) {
    if (!config.enabled) {
        return { assessment: input.heuristicAssessment, assisted: false };
    }
    const apiKey = process.env[config.apiKeyEnv ?? 'ANTHROPIC_API_KEY'];
    if (!apiKey) {
        return { assessment: input.heuristicAssessment, assisted: false };
    }
    if (input.heuristicAssessment.confidence >= 0.88 ||
        input.heuristicAssessment.confidence < 0.55) {
        return { assessment: input.heuristicAssessment, assisted: false };
    }
    try {
        const assisted = await callAnthropicAssessment(input, apiKey, config);
        return {
            assessment: {
                ...assisted,
                signals: [...input.heuristicAssessment.signals, 'model_assisted'],
            },
            assisted: true,
        };
    }
    catch {
        return {
            assessment: {
                ...input.heuristicAssessment,
                confidence: Math.min(input.heuristicAssessment.confidence, 0.55),
                signals: [...input.heuristicAssessment.signals, 'model_assist_failed'],
            },
            assisted: false,
        };
    }
}
async function callAnthropicAssessment(input, apiKey, config) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 3000);
    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: config.model ?? DEFAULT_MODEL,
                max_tokens: 256,
                messages: [
                    {
                        role: 'user',
                        content: `Classify this shell command for safety. Return JSON only with keys reversibility (reversible|recoverable_with_cost|irreversible), external (boolean), blastRadius (string), confidence (0-1 number).\nCommand: ${input.command}`,
                    },
                ],
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`model assist HTTP ${response.status}`);
        }
        const payload = (await response.json());
        const text = payload.content?.find((block) => block.type === 'text')?.text ?? '';
        const parsed = JSON.parse(text);
        return {
            reversibility: parsed.reversibility ?? input.heuristicAssessment.reversibility,
            external: parsed.external ?? input.heuristicAssessment.external,
            blastRadius: parsed.blastRadius ?? input.heuristicAssessment.blastRadius,
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
            signals: input.heuristicAssessment.signals,
        };
    }
    finally {
        clearTimeout(timeout);
    }
}
