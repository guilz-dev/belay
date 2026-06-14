import path from 'node:path';
import { loadConfigFile } from '../config-io.js';
import { buildRecoverAdvice, RECOVER_DISCLAIMER } from '../core/recover-advice.js';
import { probeGitState } from '../core/recover-git-probe.js';
import { selectRecoverTarget } from '../core/recover-select.js';
import { loadAuditRecords } from './audit.js';
import { classifyForReport } from './classify-for-report.js';
export async function recoverProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    let target = null;
    const extraWarnings = [];
    if (options.command) {
        extraWarnings.push('--command re-runs shell classification and may invoke Tier1 judge (classification only — no recovery commands are executed). Prefer audit-based recovery when possible.');
        const classified = await classifyForReport({
            targetDir: repoRoot,
            command: options.command,
            kind: 'shell',
        });
        target = {
            summary: classified.input,
            reason: classified.result.reason,
            effect: classified.result.v2?.effect,
            location: classified.result.v2?.location,
            permission: classified.permission,
            assessment: classified.result.assessment,
        };
    }
    else {
        const records = await loadAuditRecords(repoRoot);
        target = selectRecoverTarget(records, options);
    }
    const git = await probeGitState(repoRoot);
    if (!target) {
        return {
            repoRoot,
            recoverable: false,
            confidence: 'medium',
            disclaimer: [...RECOVER_DISCLAIMER],
            advice: ['No recoverable audit events found in the selected window.'],
            warnings: ['Specify --fingerprint, --since, or --command to narrow recovery advice.'],
        };
    }
    const advice = buildRecoverAdvice({
        repoRoot,
        target,
        git,
        minAssessmentConfidence: config.policy.confidenceThresholds.flag,
    });
    return {
        repoRoot,
        target: {
            timestamp: target.timestamp,
            fingerprint: target.fingerprint,
            summary: target.summary,
            reason: target.reason,
            effect: target.effect,
            location: target.location,
            permission: target.permission,
        },
        ...advice,
        warnings: [...extraWarnings, ...advice.warnings],
    };
}
export function formatRecoverReport(report) {
    const lines = [
        `agent-belay recover for ${report.repoRoot}`,
        '',
        'Disclaimer:',
        ...report.disclaimer.map((line) => `- ${line}`),
        '',
    ];
    if (report.target) {
        lines.push('Target:');
        if (report.target.timestamp) {
            lines.push(`- time: ${report.target.timestamp}`);
        }
        if (report.target.fingerprint) {
            lines.push(`- fingerprint: ${report.target.fingerprint}`);
        }
        lines.push(`- reason: ${report.target.reason}`);
        if (report.target.effect) {
            lines.push(`- effect: ${report.target.effect}`);
        }
        if (report.target.location) {
            lines.push(`- location: ${report.target.location}`);
        }
        lines.push(`- summary: ${report.target.summary}`);
        lines.push('');
    }
    lines.push(`Recoverable: ${report.recoverable ? 'possibly' : 'unlikely'} (confidence=${report.confidence})`);
    lines.push('');
    lines.push('Advice:');
    for (const line of report.advice) {
        lines.push(`- ${line}`);
    }
    if (report.warnings.length > 0) {
        lines.push('');
        lines.push('Warnings:');
        for (const warning of report.warnings) {
            lines.push(`- ${warning}`);
        }
    }
    return `${lines.join('\n')}\n`;
}
