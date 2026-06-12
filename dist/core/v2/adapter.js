import { createDeterministicJudgeStub, createOllamaJudge } from './judge.js';
import { verdict } from './verdict.js';
export function buildVerdictContext(params) {
    return {
        cwd: params.cwd,
        repoRoot: params.repoRoot,
        trustedCwd: params.trustedCwd ?? Boolean(params.cwd),
        sensitivePaths: params.options?.sensitivePaths ?? params.config.classifier.sensitivePaths,
        protectedArtifactRoots: params.options?.protectedArtifactRoots,
        judge: params.judge ??
            (params.config.policy.modelAssist.enabled
                ? createOllamaJudge(params.config.policy.modelAssist.model)
                : createDeterministicJudgeStub()),
        mode: params.config.mode,
        unknownLocalEffect: params.options?.unknownLocalEffect ?? params.config.policy.unknownLocalEffect,
        unparseableShell: params.options?.unparseableShell ?? params.config.policy.unparseableShell,
    };
}
export async function classifyShellV2(command, cwd, repoRoot, config, options = {}, judge) {
    const context = buildVerdictContext({ cwd, repoRoot, config, options, judge });
    const result = await verdict(command, context);
    return verdictToClassifyResult(result);
}
function mapLegacyReason(result) {
    if (result.reason === 'repo_outside_mutation') {
        return result.effect === 'read_only' ? 'outside_repo_redirect' : 'outside_repo_mutation';
    }
    if (result.reason === 'tier0_external') {
        return 'external_effect';
    }
    if (result.reason === 'high_stakes_path') {
        return 'protected_artifact';
    }
    if (result.reason === 'opaque_execution' &&
        /\|\s*(bash|sh|zsh|dash|fish)\b/.test(result.commandRedacted)) {
        return 'pipe_to_shell';
    }
    if (result.reason === 'launcher_unresolved' || result.reason === 'makefile_missing') {
        return 'unknown_local_effect';
    }
    if (result.reason === 'npm_script_undefined' || result.reason === 'package_json_missing') {
        return 'unknown_local_effect';
    }
    if (result.reason === 'repo_local_mutation') {
        return 'local_mutation';
    }
    return result.reason;
}
export function verdictToClassifyResult(result) {
    const external = result.location === 'external' ||
        result.location === 'repo_outside' ||
        result.effect === 'remote_mutation';
    const legacyReason = mapLegacyReason(result);
    const hookVerdict = result.permission === 'ask'
        ? 'deny_pending_approval'
        : legacyReason === 'command_substitution' ||
            legacyReason === 'unknown_local_effect' ||
            legacyReason === 'unparseable_shell' ||
            result.effect === 'local_mutation'
            ? 'allow_flagged'
            : 'allow';
    const assessment = {
        reversibility: result.effect === 'read_only'
            ? 'reversible'
            : result.permission === 'allow'
                ? 'recoverable_with_cost'
                : 'irreversible',
        external,
        blastRadius: result.location,
        confidence: result.confidence === 'deterministic'
            ? 0.95
            : result.confidence === 'llm'
                ? 0.75
                : hookVerdict === 'allow_flagged'
                    ? 0.75
                    : 0.7,
        signals: result.signals,
    };
    return {
        verdict: hookVerdict,
        reason: legacyReason,
        fingerprint: result.fingerprint,
        assessment,
        normalizedCommand: result.commandRedacted,
        summary: result.commandRedacted,
        v2: {
            location: result.location,
            opacity: result.opacity,
            effect: result.effect,
            confidence: result.confidence,
            would: result.permission,
            by: 'v2',
            commandRedacted: result.commandRedacted,
            commandFingerprint: result.fingerprint,
            signals: result.signals,
        },
    };
}
export function verdictAuditFields(result) {
    return {
        schemaVersion: 2,
        commandRedacted: result.commandRedacted,
        commandFingerprint: result.fingerprint,
        location: result.location,
        opacity: result.opacity,
        effect: result.effect,
        confidence: result.confidence,
        would: result.permission,
        by: 'v2',
        signals: result.signals,
    };
}
