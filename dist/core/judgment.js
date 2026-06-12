export function verdictFromConfidence(assessment, thresholds, unknownLocalEffect) {
    if (assessment.external || assessment.reversibility === 'irreversible') {
        if (assessment.confidence >= thresholds.allow && !assessment.external) {
            return 'allow_flagged';
        }
        return 'deny_pending_approval';
    }
    if (assessment.confidence >= thresholds.allow) {
        return 'allow';
    }
    if (assessment.confidence >= thresholds.flag) {
        return 'allow_flagged';
    }
    if (unknownLocalEffect === 'deny') {
        return 'deny_pending_approval';
    }
    return 'allow_flagged';
}
export function mergeAgentAssessment(independent, agent) {
    if (!agent) {
        return { assessment: independent, mismatch: false };
    }
    const mismatch = (agent.external === false && independent.external === true) ||
        (agent.reversibility === 'reversible' && independent.reversibility === 'irreversible');
    const confidence = mismatch
        ? Math.min(independent.confidence, 0.55)
        : Math.min(0.99, independent.confidence + 0.05);
    return {
        assessment: {
            ...independent,
            confidence,
            signals: mismatch
                ? [...independent.signals, 'agent_assessment_mismatch']
                : [...independent.signals, 'agent_assessment_agreement'],
        },
        mismatch,
    };
}
