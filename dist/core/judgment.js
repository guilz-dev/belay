const SCOPE_BLAST_RADIUS = {
    none: 'none',
    file: 'single file',
    dir: 'directory tree',
    repo: 'this repository',
    outside: 'outside the repository',
    external: 'external system',
};
export function blastRadiusLabel(scope) {
    return SCOPE_BLAST_RADIUS[scope];
}
export function computeAssessmentFromAttributes(attributes) {
    const signals = [...attributes.signals];
    if (attributes.isExternalKey || attributes.targetScope === 'external') {
        return {
            reversibility: 'irreversible',
            external: true,
            blastRadius: blastRadiusLabel(attributes.targetScope),
            confidence: calibrateConfidence(attributes, 0.92),
            signals: [...signals, 'external_command', attributes.commandKey],
        };
    }
    if (attributes.hitsProtectedArtifact) {
        return {
            reversibility: 'irreversible',
            external: false,
            blastRadius: 'agent-belay control plane',
            confidence: calibrateConfidence(attributes, 0.97),
            signals,
        };
    }
    if (attributes.hitsOutsideRepo || attributes.redirectKind === 'outside') {
        return {
            reversibility: 'irreversible',
            external: true,
            blastRadius: 'outside the repository',
            confidence: calibrateConfidence(attributes, 0.9),
            signals,
        };
    }
    if (attributes.isDynamicEval || attributes.hasPipeToShell) {
        return {
            reversibility: 'irreversible',
            external: true,
            blastRadius: 'dynamic shell evaluation',
            confidence: calibrateConfidence(attributes, 0.93),
            signals,
        };
    }
    if (attributes.isReadOnlyKey && attributes.redirectKind === 'none') {
        return {
            reversibility: 'reversible',
            external: false,
            blastRadius: blastRadiusLabel('repo'),
            confidence: calibrateConfidence(attributes, 0.95),
            signals: [...signals, 'read_only_command'],
        };
    }
    if (attributes.isFlaggedKey || attributes.redirectKind === 'truncate' || attributes.redirectKind === 'append') {
        const reversibility = attributes.flags.includes('-rf') || attributes.flags.includes('-fr')
            ? 'irreversible'
            : attributes.redirectKind === 'append'
                ? 'recoverable_with_cost'
                : 'recoverable_with_cost';
        return {
            reversibility,
            external: false,
            blastRadius: blastRadiusLabel(attributes.targetScope),
            confidence: calibrateConfidence(attributes, 0.72),
            signals: [...signals, 'local_mutation'],
        };
    }
    return {
        reversibility: 'recoverable_with_cost',
        external: false,
        blastRadius: blastRadiusLabel(attributes.targetScope),
        confidence: calibrateConfidence(attributes, 0.61),
        signals: [...signals, 'unknown_local_effect'],
    };
}
/** Corpus-calibrated confidence: strong signals increase, ambiguity decreases. */
export function calibrateConfidence(attributes, base) {
    let confidence = base;
    if (attributes.signals.length >= 2) {
        confidence = Math.min(0.99, confidence + 0.02);
    }
    if (attributes.isCustomAllow && !attributes.isCustomExternal) {
        confidence = Math.max(confidence, 0.99);
    }
    if (attributes.isUnparseable) {
        confidence = Math.max(confidence, 0.9);
    }
    if (attributes.commandKey === 'node' || attributes.commandKey === 'sed') {
        confidence = Math.min(confidence, 0.64);
    }
    return Math.round(confidence * 1000) / 1000;
}
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
