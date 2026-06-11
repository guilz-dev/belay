import { shellFingerprint } from '../fingerprint.js';
import { computeAssessmentFromAttributes, verdictFromConfidence } from '../judgment.js';
import { matchesPolicyRule } from '../shell-analysis.js';
import { DEFAULT_POLICY_RULES } from './default-rules.js';
function actionToVerdict(action, ctx) {
    if (action === 'allow') {
        return 'allow';
    }
    if (action === 'flag') {
        return 'allow_flagged';
    }
    if (action === 'deny' || action === 'escalate') {
        return 'deny_pending_approval';
    }
    if (action === 'threshold') {
        if (ctx.attributes.isUnparseable) {
            return ctx.unparseableShell === 'deny' ? 'deny_pending_approval' : 'allow_flagged';
        }
        return verdictFromConfidence(ctx.assessment, ctx.confidenceThresholds, ctx.unknownLocalEffect);
    }
    return 'allow_flagged';
}
export function evaluatePolicyRules(attributes, ctx, rules = DEFAULT_POLICY_RULES) {
    const assessment = computeAssessmentFromAttributes(attributes);
    const fullCtx = { ...ctx, attributes, assessment };
    const sorted = [...rules].sort((left, right) => right.priority - left.priority);
    if (attributes.isCustomAllow && attributes.isCustomExternal) {
        return {
            verdict: 'allow',
            reason: 'custom_allow',
            assessment: {
                ...assessment,
                confidence: 0.99,
                signals: [...assessment.signals, 'custom_allow_command'],
            },
            matchedRuleId: 'custom_allow_over_external',
        };
    }
    for (const rule of sorted) {
        if (!matchesPolicyRule(rule.match, attributes)) {
            continue;
        }
        if (rule.id === 'custom_allow' && attributes.isCustomExternal && !rule.nonOverridable) {
            continue;
        }
        if (rule.id === 'custom_external' && attributes.isCustomAllow && attributes.isCustomExternal) {
            continue;
        }
        let verdict = actionToVerdict(rule.action, fullCtx);
        let reason = rule.reason;
        let resultAssessment = rule.assessment ? { ...assessment, ...rule.assessment } : assessment;
        if (ctx.demoteL3External &&
            verdict === 'deny_pending_approval' &&
            (rule.id === 'external_effect' ||
                rule.id === 'custom_external' ||
                rule.id === 'external_script')) {
            verdict = 'allow_flagged';
            reason = 'l3_external_hint';
            resultAssessment = {
                ...resultAssessment,
                signals: [...resultAssessment.signals, 'l3_external_hint', 'egress_boundary_expected'],
            };
        }
        return {
            verdict,
            reason,
            assessment: resultAssessment,
            matchedRuleId: rule.id,
        };
    }
    return {
        verdict: verdictFromConfidence(assessment, ctx.confidenceThresholds, ctx.unknownLocalEffect),
        reason: 'unknown_local_effect',
        assessment,
        matchedRuleId: 'fallback',
    };
}
export function policyResultToClassifyResult(attributes, result) {
    return {
        verdict: result.verdict,
        reason: result.reason,
        normalizedCommand: attributes.normalizedCommand,
        fingerprint: shellFingerprint(attributes.cwdRelative, attributes.normalizedCommand),
        assessment: result.assessment,
    };
}
