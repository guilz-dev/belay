import path from 'node:path';
import { loadConfigFile } from './config-io.js';
import { isCapabilityBrokerDemotionActive } from './core/capability/broker.js';
import { classifierOptionsFromConfig, classifyShell, classifySubagent, classifyToolUse, } from './core/index.js';
import { isTransactionalEligible } from './core/transactional/index.js';
import { egressStatus } from './egress-service.js';
import { sandboxStatus } from './sandbox-service.js';
function classifyExplainTarget(options, repoRoot, cwd, classifierOptions) {
    const kind = options.kind ?? 'shell';
    if (kind === 'shell') {
        if (!options.command) {
            throw new Error('explain requires a command for shell classification.');
        }
        return {
            kind: 'shell',
            input: options.command,
            result: classifyShell(options.command, cwd, repoRoot, classifierOptions),
        };
    }
    if (kind === 'subagent') {
        const payload = options.payload ?? {
            tool_name: 'Task',
            tool_input: {
                description: options.command ?? '',
            },
        };
        if (!options.command && !options.payload) {
            throw new Error('explain requires --command or --payload-json for subagent classification.');
        }
        return {
            kind: 'subagent',
            input: options.command ?? JSON.stringify(payload),
            result: classifySubagent(payload, repoRoot, classifierOptions),
        };
    }
    if (kind === 'tool') {
        const payload = options.payload ??
            {
                tool_name: options.toolName ?? 'Shell',
                tool_input: options.toolName === 'Shell'
                    ? { command: options.command ?? '' }
                    : { path: options.command ?? '' },
            };
        if (!options.command && !options.payload) {
            throw new Error('explain requires --command or --payload-json for tool classification.');
        }
        return {
            kind: 'tool',
            input: options.command ?? JSON.stringify(payload),
            result: classifyToolUse(payload, repoRoot, cwd, classifierOptions),
        };
    }
    throw new Error(`Unknown explain kind: ${kind}`);
}
export async function explainCommand(options) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const cwd = options.cwd ? path.resolve(options.cwd) : repoRoot;
    const config = await loadConfigFile(repoRoot);
    const egress = await egressStatus({ targetDir: repoRoot });
    const sandbox = await sandboxStatus({ targetDir: repoRoot });
    const classifierOptions = {
        ...classifierOptionsFromConfig(config),
        demoteL3External: config.egress.enabled &&
            config.egress.demoteL3External &&
            egress.running &&
            !egress.repoRootMismatch &&
            !egress.foreignProxy,
        brokerFsScope: isCapabilityBrokerDemotionActive(config),
    };
    const classified = classifyExplainTarget(options, repoRoot, cwd, classifierOptions);
    const transactionalEligible = classified.kind === 'shell' && isTransactionalEligible(config, 'shell', classified.result);
    return {
        repoRoot,
        kind: classified.kind,
        command: classified.input,
        cwd,
        policy: config.policy,
        overrides: config.overrides,
        egress: config.egress,
        egressProxyRunning: egress.running && !egress.foreignProxy && !egress.repoRootMismatch,
        egressL3DemotionActive: classifierOptions.demoteL3External === true,
        sandbox: config.sandbox,
        sandboxBrokerActive: classifierOptions.brokerFsScope === true,
        l1FullActive: sandbox.l1FullActive,
        transactionalEligible,
        result: classified.result,
    };
}
export function formatExplainReport(report) {
    const { result } = report;
    const lines = [
        `agent-belay explain for ${report.repoRoot}`,
        `Kind: ${report.kind}`,
        `Input: ${report.command}`,
        `CWD: ${report.cwd}`,
        `Policy unknownLocalEffect: ${report.policy.unknownLocalEffect}`,
        `Egress (partial L1): ${report.egress.enabled ? 'enabled' : 'disabled'} (proxy running=${report.egressProxyRunning}, L3 demotion active=${report.egressL3DemotionActive})`,
        report.egress.enabled
            ? `Egress proxy: ${report.egress.listenHost}:${report.egress.listenPort}`
            : 'Egress proxy: not configured',
        `Sandbox (L1 broker): ${report.sandbox.enabled ? 'enabled' : 'disabled'} (runtime=${report.sandbox.runtime}, fs broker active=${report.sandboxBrokerActive}, L1-full=${report.l1FullActive})`,
        `Transactional (L2): ${report.policy.transactional.enabled ? 'enabled' : 'disabled'} (eligible for this command=${report.transactionalEligible})`,
        report.policy.transactional.enabled
            ? `Transactional band: [${report.policy.transactional.minConfidence}, ${report.policy.transactional.maxConfidence})`
            : 'Transactional band: not configured',
        `Overrides allow: ${report.overrides.allow.join(', ') || '(none)'}`,
        `Overrides external: ${report.overrides.external.join(', ') || '(none)'}`,
        '',
        `Verdict: ${result.verdict}`,
        `Reason: ${result.reason}`,
        `Fingerprint: ${result.fingerprint}`,
        '',
        'Predicted assessment:',
        `  reversibility: ${result.assessment.reversibility}`,
        `  external: ${result.assessment.external}`,
        `  blastRadius: ${result.assessment.blastRadius}`,
        `  confidence: ${result.assessment.confidence}`,
        `  signals: ${result.assessment.signals.join(', ') || '(none)'}`,
        report.transactionalEligible
            ? 'Observed assessment: measured in an isolated git worktree at gate time. Observed-safe commands are applied once and the hook denies re-execution (transactional_already_applied).'
            : 'Observed assessment: not applicable (transactional path not eligible).',
    ];
    return `${lines.join('\n')}\n`;
}
