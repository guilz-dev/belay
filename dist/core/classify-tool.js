import path from 'node:path';
import { classifyShell } from './classify-shell.js';
import { canonicalStringify, toolFingerprint } from './fingerprint.js';
import { matchesSensitivePath } from './glob.js';
import { pathWithinRoot, relativeWithinRepo } from './path-utils.js';
import { scrubValue } from './scrub.js';
const DEFAULT_SENSITIVE_PATHS = ['.env', '.env.*', '**/credentials/**'];
function extractFilePath(payload) {
    const toolInput = payload.tool_input;
    if (!toolInput || typeof toolInput !== 'object') {
        return null;
    }
    const input = toolInput;
    for (const key of ['path', 'file_path', 'target_file', 'filePath']) {
        if (typeof input[key] === 'string') {
            return input[key];
        }
    }
    return null;
}
function extractShellCommand(payload) {
    const toolInput = payload.tool_input;
    if (!toolInput || typeof toolInput !== 'object') {
        return null;
    }
    const input = toolInput;
    if (typeof input.command === 'string') {
        return input.command;
    }
    return null;
}
export function classifyToolUse(payload, repoRoot, cwd, options = {}) {
    const toolName = String(payload.tool_name ?? '');
    const sensitivePaths = [...DEFAULT_SENSITIVE_PATHS, ...(options.sensitivePaths ?? [])];
    if (toolName === 'Shell') {
        const command = extractShellCommand(payload);
        if (!command) {
            return {
                verdict: 'allow_flagged',
                reason: 'tool_shell_missing_command',
                summary: canonicalStringify(scrubValue(payload.tool_input ?? {})),
                fingerprint: toolFingerprint(toolName, scrubValue(payload.tool_input ?? {}), repoRoot),
                assessment: {
                    reversibility: 'recoverable_with_cost',
                    external: false,
                    blastRadius: 'tool shell',
                    confidence: 0.5,
                    signals: ['missing_command'],
                },
            };
        }
        const shellResult = classifyShell(command, cwd, repoRoot, options);
        return {
            ...shellResult,
            summary: command,
        };
    }
    if (toolName === 'Write' || toolName === 'StrReplace' || toolName === 'Delete') {
        const filePath = extractFilePath(payload);
        if (!filePath) {
            return {
                verdict: 'allow_flagged',
                reason: 'file_mutation_missing_path',
                summary: canonicalStringify(scrubValue(payload.tool_input ?? {})),
                fingerprint: toolFingerprint(toolName, scrubValue(payload.tool_input ?? {}), repoRoot),
                assessment: {
                    reversibility: 'recoverable_with_cost',
                    external: false,
                    blastRadius: 'file mutation',
                    confidence: 0.55,
                    signals: ['missing_path'],
                },
            };
        }
        const signals = [];
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
        if (options.controlPlaneDir && pathWithinRoot(options.controlPlaneDir, resolvedPath)) {
            signals.push('control_plane_path');
            return {
                verdict: 'deny_pending_approval',
                reason: 'control_plane_mutation',
                summary: filePath,
                fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
                assessment: {
                    reversibility: 'irreversible',
                    external: false,
                    blastRadius: 'agent-belay control plane',
                    confidence: 0.97,
                    signals,
                },
            };
        }
        const relativePath = relativeWithinRepo(repoRoot, resolvedPath);
        if (relativePath === null) {
            signals.push('outside_repo_path');
            return {
                verdict: 'deny_pending_approval',
                reason: 'outside_repo_file_mutation',
                summary: filePath,
                fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
                assessment: {
                    reversibility: 'irreversible',
                    external: true,
                    blastRadius: 'outside the repository',
                    confidence: 0.9,
                    signals,
                },
            };
        }
        if (matchesSensitivePath(relativePath, sensitivePaths)) {
            signals.push('sensitive_path');
            return {
                verdict: 'deny_pending_approval',
                reason: 'sensitive_file_mutation',
                summary: filePath,
                fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
                assessment: {
                    reversibility: 'irreversible',
                    external: false,
                    blastRadius: 'sensitive repository file',
                    confidence: 0.88,
                    signals,
                },
            };
        }
        if (toolName === 'Delete') {
            signals.push('file_delete');
            return {
                verdict: 'allow_flagged',
                reason: 'file_delete',
                summary: filePath,
                fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
                assessment: {
                    reversibility: 'recoverable_with_cost',
                    external: false,
                    blastRadius: 'this repository',
                    confidence: 0.7,
                    signals,
                },
            };
        }
        signals.push('file_mutation');
        return {
            verdict: 'allow_flagged',
            reason: 'file_mutation',
            summary: filePath,
            fingerprint: toolFingerprint(toolName, { path: filePath }, repoRoot),
            assessment: {
                reversibility: 'recoverable_with_cost',
                external: false,
                blastRadius: 'this repository',
                confidence: 0.68,
                signals,
            },
        };
    }
    return {
        verdict: 'allow',
        reason: 'unclassified_tool',
        summary: canonicalStringify(scrubValue(payload.tool_input ?? {})),
        fingerprint: toolFingerprint(toolName, scrubValue(payload.tool_input ?? {}), repoRoot),
        assessment: {
            reversibility: 'reversible',
            external: false,
            blastRadius: 'tool scope',
            confidence: 0.5,
            signals: ['unclassified_tool'],
        },
    };
}
