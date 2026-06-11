import { DEFAULT_CONFIDENCE_THRESHOLDS } from './config.js';
import { shellFingerprint } from './fingerprint.js';
import { normalizeToken, relativeWithinRepo } from './path-utils.js';
import { evaluatePolicyRules, policyResultToClassifyResult } from './policy/evaluator.js';
import { analyzeShellSegment } from './shell-analysis.js';
import { findCommandSubstitutions, MAX_SUBSTITUTION_DEPTH } from './shell-substitution.js';
import { commandKey, normalizeShellCommand, tokenizeShell } from './shell-tokenizer.js';
import { detectUnparseableShell } from './shell-unparseable.js';
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish']);
const INTERPRETER_SCRIPT_FLAGS = new Set(['-c', '-lc', '-e', '--eval']);
const VERDICT_RANK = {
    allow: 0,
    allow_flagged: 1,
    deny_pending_approval: 2,
};
function worseVerdict(left, right) {
    const leftRank = VERDICT_RANK[left.verdict] ?? 0;
    const rightRank = VERDICT_RANK[right.verdict] ?? 0;
    if (rightRank > leftRank) {
        return right;
    }
    if (rightRank < leftRank) {
        return left;
    }
    return right;
}
function denyResult(params) {
    return {
        verdict: 'deny_pending_approval',
        reason: params.reason,
        normalizedCommand: params.normalizedCommand,
        fingerprint: shellFingerprint(params.cwdRelative, params.normalizedCommand),
        assessment: params.assessment,
    };
}
function splitSegmentsWithSeparators(tokens) {
    const segments = [];
    let current = [];
    let separator = 'start';
    const flush = () => {
        if (current.length > 0) {
            segments.push({ tokens: current, separator });
            current = [];
        }
    };
    for (const token of tokens) {
        if (token === '&&' || token === '||' || token === ';' || token === '|') {
            flush();
            separator = token;
            continue;
        }
        current.push(token);
    }
    flush();
    return segments;
}
function unparseableShellResult(normalizedCommand, cwdRelative, options) {
    const assessment = {
        reversibility: 'irreversible',
        external: false,
        blastRadius: 'unparseable shell construct',
        confidence: 0.9,
        signals: ['unparseable_shell'],
    };
    if (options.unparseableShell === 'deny') {
        return denyResult({
            reason: 'unparseable_shell',
            normalizedCommand,
            cwdRelative,
            assessment,
        });
    }
    return {
        verdict: 'allow_flagged',
        reason: 'unparseable_shell',
        normalizedCommand,
        fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
        assessment,
    };
}
function classifySubstitutionInners(params) {
    const { command, cwd, repoRoot, options, depth } = params;
    if (depth >= MAX_SUBSTITUTION_DEPTH) {
        return null;
    }
    const substitutions = findCommandSubstitutions(command);
    if (substitutions.length === 0) {
        return null;
    }
    const normalizedCommand = normalizeShellCommand(command, repoRoot, normalizeToken);
    const cwdRelative = relativeWithinRepo(repoRoot, cwd) ?? cwd;
    let worst = null;
    for (const substitution of substitutions) {
        const inner = classifyShell(substitution, cwd, repoRoot, options, depth + 1);
        if (options.unknownLocalEffect === 'deny') {
            return denyResult({
                reason: 'command_substitution',
                normalizedCommand,
                cwdRelative,
                assessment: {
                    reversibility: 'irreversible',
                    external: inner.assessment.external,
                    blastRadius: 'command substitution',
                    confidence: 0.9,
                    signals: ['command_substitution', ...inner.assessment.signals],
                },
            });
        }
        const wrapped = wrapInnerVerdict({
            inner,
            normalizedCommand,
            cwdRelative,
            wrapReason: 'command_substitution',
            wrapSignal: 'command_substitution',
        });
        worst = worst ? worseVerdict(worst, wrapped) : wrapped;
    }
    return worst;
}
function extractInterpreterScript(tokens) {
    for (let index = 1; index < tokens.length; index += 1) {
        const flag = tokens[index];
        if (INTERPRETER_SCRIPT_FLAGS.has(flag)) {
            return tokens[index + 1] ?? null;
        }
    }
    return null;
}
function wrapInnerVerdict(params) {
    const { inner, normalizedCommand, cwdRelative, wrapReason, wrapSignal } = params;
    const signals = [wrapSignal, ...inner.assessment.signals];
    if (inner.verdict === 'deny_pending_approval') {
        return {
            ...inner,
            normalizedCommand,
            fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
            reason: wrapReason,
            assessment: {
                ...inner.assessment,
                signals,
            },
        };
    }
    if (inner.verdict === 'allow_flagged') {
        return {
            ...inner,
            normalizedCommand,
            fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
            reason: wrapReason,
            assessment: {
                ...inner.assessment,
                signals,
            },
        };
    }
    if (inner.verdict === 'allow') {
        return {
            verdict: 'allow_flagged',
            reason: wrapReason,
            normalizedCommand,
            fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
            assessment: {
                reversibility: 'recoverable_with_cost',
                external: inner.assessment.external,
                blastRadius: inner.assessment.blastRadius,
                confidence: Math.min(inner.assessment.confidence, 0.7),
                signals,
            },
        };
    }
    return inner;
}
function classifySegment(segment, cwd, repoRoot, normalizedCommand, cwdRelative, options, depth) {
    const segmentTokens = segment.tokens;
    const key = commandKey(segmentTokens);
    if (depth < 2) {
        const innerScript = extractInterpreterScript(segmentTokens);
        if (innerScript && (SHELL_INTERPRETERS.has(key) || key === 'node')) {
            const inner = classifyShell(innerScript, cwd, repoRoot, options, depth + 1);
            const wrapReason = key === 'node' ? 'node_eval' : 'shell_interpreter_script';
            const wrapSignal = key === 'node' ? 'node_eval' : 'shell_interpreter_script';
            return wrapInnerVerdict({
                inner,
                normalizedCommand,
                cwdRelative,
                wrapReason,
                wrapSignal,
            });
        }
    }
    const attributes = analyzeShellSegment({
        segmentTokens,
        cwd,
        repoRoot,
        normalizedCommand,
        cwdRelative,
        options,
        separator: segment.separator,
    });
    const policyResult = evaluatePolicyRules(attributes, {
        unknownLocalEffect: options.unknownLocalEffect ?? 'allow_flagged',
        unparseableShell: options.unparseableShell ?? 'allow_flagged',
        confidenceThresholds: options.confidenceThresholds ?? DEFAULT_CONFIDENCE_THRESHOLDS,
    });
    return policyResultToClassifyResult(attributes, policyResult);
}
export function classifyShell(command, cwd, repoRoot, options = {}, depth = 0) {
    const normalizedCommand = normalizeShellCommand(command, repoRoot, normalizeToken);
    const cwdRelative = relativeWithinRepo(repoRoot, cwd) ?? cwd;
    if (depth === 0 && detectUnparseableShell(command)) {
        return unparseableShellResult(normalizedCommand, cwdRelative, options);
    }
    const substitutionResult = classifySubstitutionInners({
        command,
        cwd,
        repoRoot,
        options,
        depth,
    });
    const tokens = tokenizeShell(command);
    const segments = splitSegmentsWithSeparators(tokens);
    let effective = {
        verdict: 'allow',
        reason: 'read_only',
        normalizedCommand,
        fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
        assessment: {
            reversibility: 'reversible',
            external: false,
            blastRadius: 'this repository',
            confidence: 0.95,
            signals: ['read_only'],
        },
    };
    for (let index = 0; index < segments.length; index += 1) {
        const result = classifySegment(segments[index], cwd, repoRoot, normalizedCommand, cwdRelative, options, depth);
        effective = worseVerdict(effective, result);
        if (result.verdict === 'deny_pending_approval' && options.strictChains !== true) {
            break;
        }
    }
    if (substitutionResult) {
        effective = worseVerdict(effective, substitutionResult);
    }
    return effective;
}
