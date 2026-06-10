import { canonicalStringify, subagentFingerprint } from './fingerprint.js';
import { scrubValue } from './scrub.js';
const EXTERNAL_PHRASES = [
    'deploy to production',
    'deploy to prod',
    'publish to npm',
    'publish package',
    'release to production',
    'ship to production',
    'send email',
    'notify slack',
    'call external api',
    'push to production',
    'push to prod',
];
const INVESTIGATION_PHRASES = [
    'investigate',
    'debug',
    'research',
    'review',
    'analyze',
    'analyse',
    'check',
    'look into',
    'understand',
    'explore',
];
const EXTERNAL_TERMS = [
    'deploy',
    'production',
    'publish',
    'release',
    'ship',
    'notify',
    'email',
    'prod',
];
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
    const signals = [];
    for (const phrase of EXTERNAL_PHRASES) {
        if (lowered.includes(phrase)) {
            signals.push('external_phrase', phrase);
            return {
                verdict: 'deny_pending_approval',
                reason: 'external_subagent_intent',
                summary,
                fingerprint,
                assessment: {
                    reversibility: 'irreversible',
                    external: true,
                    blastRadius: 'subagent requested external effect',
                    confidence: 0.92,
                    signals,
                },
            };
        }
    }
    const isInvestigation = INVESTIGATION_PHRASES.some((phrase) => lowered.includes(phrase));
    const hasExternalTerm = EXTERNAL_TERMS.some((term) => {
        const pattern = new RegExp(`\\b${term}\\b`, 'i');
        return pattern.test(lowered);
    });
    if (hasExternalTerm && !isInvestigation) {
        signals.push('external_term');
        return {
            verdict: 'deny_pending_approval',
            reason: 'external_subagent_intent',
            summary,
            fingerprint,
            assessment: {
                reversibility: 'irreversible',
                external: true,
                blastRadius: 'subagent requested external effect',
                confidence: 0.85,
                signals,
            },
        };
    }
    if (hasExternalTerm && isInvestigation) {
        signals.push('external_term_investigation_context');
        return {
            verdict: 'allow_flagged',
            reason: 'subagent_review',
            summary,
            fingerprint,
            assessment: {
                reversibility: 'recoverable_with_cost',
                external: false,
                blastRadius: 'subagent task scope',
                confidence: 0.7,
                signals,
            },
        };
    }
    return {
        verdict: 'allow_flagged',
        reason: 'subagent_review',
        summary,
        fingerprint,
        assessment: {
            reversibility: 'recoverable_with_cost',
            external: false,
            blastRadius: 'subagent task scope',
            confidence: 0.67,
            signals: ['subagent_default_review'],
        },
    };
}
