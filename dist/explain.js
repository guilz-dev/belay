import path from 'node:path';
import { loadConfigFile } from './config-io.js';
import { classifierOptionsFromConfig, classifyShell } from './core/index.js';
export async function explainCommand(options) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const cwd = options.cwd ? path.resolve(options.cwd) : repoRoot;
    const config = await loadConfigFile(repoRoot);
    const classifierOptions = classifierOptionsFromConfig(config);
    const result = classifyShell(options.command, cwd, repoRoot, classifierOptions);
    return {
        repoRoot,
        command: options.command,
        cwd,
        result,
    };
}
export function formatExplainReport(report) {
    const { result } = report;
    const lines = [
        `agent-belay explain for ${report.repoRoot}`,
        `Command: ${report.command}`,
        `CWD: ${report.cwd}`,
        '',
        `Verdict: ${result.verdict}`,
        `Reason: ${result.reason}`,
        `Fingerprint: ${result.fingerprint}`,
        '',
        'Assessment:',
        `  reversibility: ${result.assessment.reversibility}`,
        `  external: ${result.assessment.external}`,
        `  blastRadius: ${result.assessment.blastRadius}`,
        `  confidence: ${result.assessment.confidence}`,
        `  signals: ${result.assessment.signals.join(', ') || '(none)'}`,
    ];
    return `${lines.join('\n')}\n`;
}
