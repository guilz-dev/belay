import { canonicalStringify, subagentFingerprint } from './fingerprint.js';
import { scrubValue } from './scrub.js';
const EXTERNAL_TERMS = ['deploy', 'production', 'publish', 'release', 'ship', 'notify', 'email'];
function extractSubagentText(payload, options) {
    const toolInput = payload.tool_input;
    if (toolInput && typeof toolInput === 'object') {
        const input = toolInput;
        const description = typeof input.description === 'string' ? input.description : '';
        const prompt = typeof input.prompt === 'string' ? input.prompt : '';
        return [description, prompt].filter(Boolean).join(' ');
    }
    const task = payload.task;
    if (typeof task === 'string') {
        return task;
    }
    if (task && typeof task === 'object') {
        const taskObj = task;
        const description = typeof taskObj.description === 'string' ? taskObj.description : '';
        const prompt = typeof taskObj.prompt === 'string' ? taskObj.prompt : '';
        return [description, prompt].filter(Boolean).join(' ');
    }
    return canonicalStringify(scrubValue(payload, options.scrubOptions));
}
function fingerprintSource(payload, options) {
    const toolInput = payload.tool_input;
    if (toolInput && typeof toolInput === 'object') {
        const input = toolInput;
        return scrubValue({
            description: input.description ?? '',
            prompt: input.prompt ?? '',
        }, options.scrubOptions);
    }
    const task = payload.task;
    if (typeof task === 'string') {
        return scrubValue({ task }, options.scrubOptions);
    }
    if (task && typeof task === 'object') {
        const taskObj = task;
        return scrubValue({
            description: taskObj.description ?? '',
            prompt: taskObj.prompt ?? '',
        }, options.scrubOptions);
    }
    return scrubValue(payload, options.scrubOptions);
}
export function classifySubagent(payload, repoRoot, options = {}) {
    const kind = payload.tool_name === 'Task' ? 'Task' : String(payload.subagent_type ?? 'generalPurpose');
    const scrubbed = fingerprintSource(payload, options);
    const summary = extractSubagentText(payload, options);
    const lowered = summary.toLowerCase();
    const fingerprint = subagentFingerprint(kind, scrubbed, repoRoot);
    const hasExternalTerm = EXTERNAL_TERMS.some((term) => {
        const pattern = new RegExp(`\\b${term}\\b`, 'i');
        return pattern.test(lowered);
    });
    return {
        verdict: 'allow_flagged',
        reason: 'subagent_review',
        summary,
        fingerprint,
        assessment: {
            reversibility: 'recoverable_with_cost',
            external: false,
            blastRadius: 'subagent task scope',
            confidence: hasExternalTerm ? 0.7 : 0.67,
            signals: hasExternalTerm ? ['subagent_external_intent_hint'] : ['subagent_default_review'],
        },
    };
}
