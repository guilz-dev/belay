import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyResultToGateVerdict, unnormalizedGateVerdict, } from '../../core/gate-contract.js';
import { classifyGatedActionAsync, extractAgentAssessment, GateNormalizationError, gateEnabledForAction, normalizeGatedAction, } from '../../core/gate-engine.js';
import { approvalCommandMatch, approvedApprovalsFile, buildRetryInstruction, canonicalStringify, classifierOptionsFromConfig, compactApprovals, createApprovalRecord, mergeConfig, pendingApprovalsFile, persistControlPlaneSpikeResult, resolveControlPlaneDir, runControlPlaneSpike, scrubOptionsFromConfig, scrubValue, } from '../../core/index.js';
import { protectedArtifactRoots } from '../layouts/protected-paths.js';
const EMPTY_APPROVALS = {
    version: 1,
    approvals: [],
};
async function loadJsonFile(filePath, fallback) {
    try {
        const raw = await readFile(filePath, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
export function createDefaultGateRuntimeDeps() {
    return {
        async readConfig(configPath) {
            return loadJsonFile(configPath, {});
        },
        async appendAudit(ctx, event) {
            const auditPath = path.join(ctx.repoRoot, ctx.config.audit.logPath);
            await mkdir(path.dirname(auditPath), { recursive: true });
            const record = { timestamp: new Date().toISOString(), ...event };
            if (!ctx.config.audit.includeAssessment) {
                delete record.assessment;
            }
            const scrubbed = scrubValue(record, scrubOptionsFromConfig(ctx.config));
            await writeFile(auditPath, `${JSON.stringify(scrubbed)}\n`, {
                encoding: 'utf8',
                flag: 'a',
            });
        },
        async loadApprovals(ctx, fileName) {
            const repoLocalStateDir = ctx.layout.repoLocalStateDir(ctx.repoRoot);
            const filePath = fileName === 'pending-approvals.json'
                ? pendingApprovalsFile(ctx.config, repoLocalStateDir)
                : approvedApprovalsFile(ctx.config, repoLocalStateDir);
            const loaded = await loadJsonFile(filePath, EMPTY_APPROVALS);
            return {
                filePath,
                state: {
                    version: 1,
                    approvals: Array.isArray(loaded.approvals) ? loaded.approvals : [],
                },
            };
        },
        async writeApprovals(filePath, state) {
            await mkdir(path.dirname(filePath), { recursive: true });
            await writeFile(filePath, `${JSON.stringify(compactApprovals(state), null, 2)}\n`, 'utf8');
        },
    };
}
export async function resolveGateConfig(ctx, deps) {
    const loaded = await deps.readConfig(ctx.configPath);
    return mergeConfig(loaded, ctx.layout.defaultConfig(ctx.repoRoot));
}
export function runtimeClassifierOptions(ctx, config) {
    const controlPlaneDir = config.controlPlane.enabled ? resolveControlPlaneDir(config) : null;
    return {
        ...classifierOptionsFromConfig(config),
        protectedArtifactRoots: protectedArtifactRoots(ctx.layout, ctx.repoRoot, controlPlaneDir),
    };
}
function gateAuditEventName(kind) {
    if (kind === 'shell') {
        return 'beforeShellExecution';
    }
    if (kind === 'tool') {
        return 'preToolUse';
    }
    return 'subagentGate';
}
async function ensurePendingApproval(ctx, deps, kind, result) {
    const pending = await deps.loadApprovals(ctx, 'pending-approvals.json');
    pending.state = compactApprovals(pending.state);
    const existing = pending.state.approvals.find((approval) => approval.kind === kind &&
        approval.fingerprint === result.fingerprint &&
        approval.repoRoot === ctx.repoRoot);
    if (existing) {
        await deps.writeApprovals(pending.filePath, pending.state);
        return existing;
    }
    const approval = createApprovalRecord({
        kind,
        fingerprint: result.fingerprint,
        repoRoot: ctx.repoRoot,
        reason: result.reason,
        summary: result.normalizedCommand ?? result.summary ?? '',
        approvalTtlMinutes: ctx.config.approvalTtlMinutes,
        approvalId: `belay_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    pending.state.approvals.push(approval);
    await deps.writeApprovals(pending.filePath, pending.state);
    return approval;
}
async function consumeApprovedApproval(ctx, deps, kind, fingerprint) {
    const approved = await deps.loadApprovals(ctx, 'approved-approvals.json');
    approved.state = compactApprovals(approved.state);
    const index = approved.state.approvals.findIndex((approval) => approval.kind === kind &&
        approval.fingerprint === fingerprint &&
        approval.repoRoot === ctx.repoRoot);
    if (index === -1) {
        await deps.writeApprovals(approved.filePath, approved.state);
        return null;
    }
    const [approval] = approved.state.approvals.splice(index, 1);
    await deps.writeApprovals(approved.filePath, approved.state);
    return approval;
}
export async function evaluateGatedAction(ctx, deps, params) {
    let action;
    try {
        action = normalizeGatedAction({
            kind: params.kind,
            repoRoot: ctx.repoRoot,
            cwd: params.cwd,
            command: params.command,
            payload: params.payload,
            toolName: params.toolName,
            agentAssessment: extractAgentAssessment(params.payload),
        });
    }
    catch {
        const verdict = unnormalizedGateVerdict({
            reason: 'normalization_failed',
            mode: ctx.config.mode,
            user_message: 'agent-belay could not normalize this gated action. Run agent-belay doctor, then retry.',
            agent_message: 'Belay denied this action because the hook payload could not be normalized.',
        });
        await deps.appendAudit(ctx, {
            event: gateAuditEventName(params.kind),
            kind: params.kind,
            verdict: verdict.verdict,
            reason: verdict.reason,
            mode: ctx.config.mode,
            wouldBlock: true,
            permission: 'deny',
        });
        return verdict;
    }
    if (!gateEnabledForAction(ctx.config, action)) {
        return classifyResultToGateVerdict({
            result: {
                verdict: 'allow',
                reason: 'gate_disabled',
                fingerprint: 'gate_disabled',
                assessment: {
                    reversibility: 'reversible',
                    external: false,
                    blastRadius: 'none',
                    confidence: 1,
                    signals: ['gate_disabled'],
                },
            },
            mode: ctx.config.mode,
            permission: 'allow',
            wouldBlock: false,
        });
    }
    const result = await classifyGatedActionAsync(action, ctx.config, runtimeClassifierOptions(ctx, ctx.config));
    return gateDecisionToVerdict(ctx, deps, params.kind, result);
}
async function gateDecisionToVerdict(ctx, deps, kind, result) {
    const gateBase = {
        event: gateAuditEventName(kind),
        kind,
        fingerprint: result.fingerprint,
        summary: result.normalizedCommand ?? result.summary ?? '',
        assessment: result.assessment,
        mode: ctx.config.mode,
    };
    const approved = await consumeApprovedApproval(ctx, deps, kind, result.fingerprint);
    if (approved) {
        await deps.appendAudit(ctx, {
            ...gateBase,
            verdict: 'allow',
            reason: 'approved_once',
            approvalId: approved.approvalId,
            wouldBlock: false,
            permission: 'allow',
        });
        return classifyResultToGateVerdict({
            result: { ...result, verdict: 'allow', reason: 'approved_once' },
            mode: ctx.config.mode,
            permission: 'allow',
            wouldBlock: false,
            approvalId: approved.approvalId,
        });
    }
    if (result.verdict === 'allow' || result.verdict === 'allow_flagged') {
        await deps.appendAudit(ctx, {
            ...gateBase,
            verdict: result.verdict,
            reason: result.reason,
            wouldBlock: false,
            permission: 'allow',
        });
        return classifyResultToGateVerdict({
            result,
            mode: ctx.config.mode,
            permission: 'allow',
            wouldBlock: false,
        });
    }
    if (ctx.config.mode === 'audit') {
        await deps.appendAudit(ctx, {
            ...gateBase,
            verdict: result.verdict,
            reason: result.reason,
            wouldBlock: true,
            permission: 'allow',
        });
        return classifyResultToGateVerdict({
            result,
            mode: ctx.config.mode,
            permission: 'allow',
            wouldBlock: true,
        });
    }
    const approval = await ensurePendingApproval(ctx, deps, kind, result);
    await deps.appendAudit(ctx, {
        ...gateBase,
        verdict: result.verdict,
        reason: result.reason,
        approvalId: approval.approvalId,
        wouldBlock: true,
        permission: 'deny',
    });
    return classifyResultToGateVerdict({
        result,
        mode: ctx.config.mode,
        permission: 'deny',
        wouldBlock: true,
        approvalId: approval.approvalId,
        user_message: `Belay blocked this high-risk action. Approval ID: ${approval.approvalId}. ${buildRetryInstruction(ctx.config.tokenPrefix, approval.approvalId)}`,
        agent_message: `Belay denied this action as ${result.reason}. Wait for approval, then retry the exact same action once.`,
    });
}
export async function processApprovalPrompt(ctx, deps, prompt) {
    const approvalId = approvalCommandMatch(prompt, ctx.config.tokenPrefix);
    if (!approvalId) {
        return { continue: true };
    }
    const pending = await deps.loadApprovals(ctx, 'pending-approvals.json');
    pending.state = compactApprovals(pending.state);
    const index = pending.state.approvals.findIndex((approval) => approval.approvalId === approvalId);
    if (index === -1) {
        await deps.writeApprovals(pending.filePath, pending.state);
        await deps.appendAudit(ctx, {
            event: 'approval',
            kind: 'approval',
            verdict: 'deny_pending_approval',
            approvalId,
            reason: 'approval_missing',
            summary: prompt,
        });
        return {
            continue: false,
            user_message: 'Belay approval not found or expired.',
        };
    }
    const [approval] = pending.state.approvals.splice(index, 1);
    await deps.writeApprovals(pending.filePath, pending.state);
    const approved = await deps.loadApprovals(ctx, 'approved-approvals.json');
    approved.state = compactApprovals(approved.state);
    approved.state.approvals.push({
        ...approval,
        approvedAt: new Date().toISOString(),
    });
    await deps.writeApprovals(approved.filePath, approved.state);
    await deps.appendAudit(ctx, {
        event: 'approval',
        kind: 'approval',
        verdict: 'allow',
        approvalId,
        reason: 'approval_recorded',
        summary: prompt,
    });
    return {
        continue: false,
        user_message: `Belay approval recorded for ${approvalId}. Retry the original action once before it expires.`,
    };
}
const controlPlaneSpikeRanFor = new Set();
export async function maybeRunControlPlaneSpike(ctx, deps, envEnabled) {
    if (!envEnabled && !ctx.config.controlPlane.spikeOnPrompt) {
        return;
    }
    const spikeKey = `${ctx.repoRoot}:${ctx.configPath}`;
    if (controlPlaneSpikeRanFor.has(spikeKey)) {
        return;
    }
    controlPlaneSpikeRanFor.add(spikeKey);
    const controlPlaneDir = ctx.config.controlPlane.configDir ?? resolveControlPlaneDir(ctx.config);
    const homedir = () => process.env.HOME ?? process.env.USERPROFILE ?? '';
    const spike = await runControlPlaneSpike(process.env, process.cwd(), homedir, controlPlaneDir);
    const spikePath = await persistControlPlaneSpikeResult(spike, process.env, homedir, controlPlaneDir);
    await deps.appendAudit(ctx, {
        event: 'controlPlaneSpike',
        kind: 'diagnostic',
        verdict: spike.ok ? 'allow' : 'deny_pending_approval',
        reason: spike.ok ? 'control_plane_writable' : 'control_plane_blocked',
        summary: spike.error ?? spikePath,
        mode: ctx.config.mode,
        wouldBlock: !spike.ok,
        permission: 'allow',
    });
}
export function gateVerdictToCursorResponse(verdict) {
    return {
        permission: verdict.permission,
        user_message: verdict.user_message,
        agent_message: verdict.agent_message,
    };
}
export function gateVerdictToClaudePreToolUseResponse(verdict) {
    if (verdict.permission === 'allow') {
        return {};
    }
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: verdict.user_message ??
                verdict.agent_message ??
                `Belay denied this action (${verdict.reason}).`,
        },
    };
}
export function gateVerdictToClaudeUserPromptResponse(verdict) {
    if (verdict.continue) {
        return {};
    }
    return {
        hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            continue: false,
            user_message: verdict.user_message,
        },
    };
}
export async function appendObservedAudit(ctx, deps, eventName, payload) {
    await deps.appendAudit(ctx, {
        event: eventName,
        kind: 'audit',
        verdict: 'allow',
        reason: 'observed',
        summary: canonicalStringify(payload),
    });
}
export { GateNormalizationError };
