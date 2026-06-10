import { shellFingerprint } from './fingerprint.js';
import { hasOutsideRepoPath, normalizeToken, relativeWithinRepo, resolveMutationTarget, } from './path-utils.js';
import { commandKey, extractRedirectTargets, normalizeShellCommand, tokenizeShell, } from './shell-tokenizer.js';
const READ_ONLY_COMMANDS = new Set([
    'cat',
    'cd',
    'echo',
    'find',
    'git diff',
    'git log',
    'git rev-parse',
    'git show',
    'git status',
    'head',
    'ls',
    'node',
    'pwd',
    'rg',
    'sed',
    'sort',
    'tail',
    'wc',
    'which',
]);
const FLAGGED_COMMANDS = new Set([
    'chmod',
    'cp',
    'git add',
    'git clean',
    'git commit',
    'git mv',
    'git reset',
    'mkdir',
    'mv',
    'rm',
    'tee',
    'touch',
    'truncate',
]);
const EXTERNAL_COMMANDS = new Set([
    'aws',
    'curl',
    'docker push',
    'docker run',
    'firebase deploy',
    'fly deploy',
    'gh',
    'git push',
    'gcloud',
    'heroku',
    'kubectl',
    'netlify',
    'npm publish',
    'pnpm publish',
    'rsync',
    'scp',
    'ssh',
    'supabase',
    'terraform apply',
    'vercel',
    'wget',
]);
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish']);
const EXTERNAL_SCRIPT_TERMS = ['deploy', 'publish', 'release', 'ship', 'prod'];
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
function isExternalKey(key, options) {
    return EXTERNAL_COMMANDS.has(key) || (options.customExternalCommands ?? []).some((c) => c === key);
}
function classifySegment(segment, cwd, repoRoot, normalizedCommand, cwdRelative, options) {
    const segmentTokens = segment.tokens;
    const key = commandKey(segmentTokens);
    const redirects = extractRedirectTargets(segmentTokens);
    const signals = [];
    for (const custom of options.customAllowCommands ?? []) {
        if (normalizedCommand.includes(custom) || key === custom) {
            return {
                verdict: 'allow',
                reason: 'custom_allow',
                normalizedCommand,
                fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
                assessment: {
                    reversibility: 'reversible',
                    external: false,
                    blastRadius: 'this repository',
                    confidence: 0.99,
                    signals: ['custom_allow_command'],
                },
            };
        }
    }
    for (const custom of options.customExternalCommands ?? []) {
        if (normalizedCommand.includes(custom) || key === custom) {
            return denyResult({
                reason: 'custom_external',
                normalizedCommand,
                cwdRelative,
                assessment: {
                    reversibility: 'irreversible',
                    external: true,
                    blastRadius: 'custom external command',
                    confidence: 0.95,
                    signals: ['custom_external_command'],
                },
            });
        }
    }
    const hasOutsideRedirect = redirects.some((target) => {
        const resolved = resolveMutationTarget(target, cwd);
        if (!resolved) {
            return false;
        }
        return relativeWithinRepo(repoRoot, resolved) === null;
    });
    if (hasOutsideRedirect) {
        signals.push('outside_repo_redirect');
        return denyResult({
            reason: 'outside_repo_redirect',
            normalizedCommand,
            cwdRelative,
            assessment: {
                reversibility: 'irreversible',
                external: true,
                blastRadius: 'outside the repository',
                confidence: 0.92,
                signals,
            },
        });
    }
    if (FLAGGED_COMMANDS.has(key) && hasOutsideRepoPath(segmentTokens.slice(1), cwd, repoRoot)) {
        signals.push('outside_repo_mutation');
        return denyResult({
            reason: 'outside_repo_mutation',
            normalizedCommand,
            cwdRelative,
            assessment: {
                reversibility: 'irreversible',
                external: true,
                blastRadius: 'outside the repository',
                confidence: 0.9,
                signals,
            },
        });
    }
    if (segment.separator === '|' && SHELL_INTERPRETERS.has(key)) {
        signals.push('pipe_to_shell');
        return denyResult({
            reason: 'pipe_to_shell',
            normalizedCommand,
            cwdRelative,
            assessment: {
                reversibility: 'irreversible',
                external: true,
                blastRadius: 'shell interpreter via pipe',
                confidence: 0.94,
                signals,
            },
        });
    }
    if ((key === 'npm run' || key === 'pnpm run') && segmentTokens[2]) {
        const scriptName = segmentTokens[2].toLowerCase();
        if (EXTERNAL_SCRIPT_TERMS.some((term) => scriptName.includes(term))) {
            signals.push('external_script_name', scriptName);
            return denyResult({
                reason: 'external_script',
                normalizedCommand,
                cwdRelative,
                assessment: {
                    reversibility: 'irreversible',
                    external: true,
                    blastRadius: `npm script: ${scriptName}`,
                    confidence: 0.88,
                    signals,
                },
            });
        }
    }
    if (key === 'curl' || key === 'wget') {
        const hasAuthHeader = segmentTokens.some((token) => token === '-H' || token === '--header' || /authorization/i.test(token));
        if (hasAuthHeader) {
            signals.push('credential_header');
            return {
                verdict: 'allow_flagged',
                reason: 'credential_header',
                normalizedCommand,
                fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
                assessment: {
                    reversibility: 'recoverable_with_cost',
                    external: true,
                    blastRadius: 'external request with credentials',
                    confidence: 0.75,
                    signals,
                },
            };
        }
    }
    if (isExternalKey(key, options)) {
        signals.push('external_command', key);
        return denyResult({
            reason: 'external_effect',
            normalizedCommand,
            cwdRelative,
            assessment: {
                reversibility: 'irreversible',
                external: true,
                blastRadius: key === 'git push' ? 'remote origin' : 'external system',
                confidence: 0.92,
                signals,
            },
        });
    }
    if (READ_ONLY_COMMANDS.has(key)) {
        return {
            verdict: 'allow',
            reason: 'read_only',
            normalizedCommand,
            fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
            assessment: {
                reversibility: 'reversible',
                external: false,
                blastRadius: 'this repository',
                confidence: 0.95,
                signals: ['read_only_command'],
            },
        };
    }
    if (FLAGGED_COMMANDS.has(key) || redirects.length > 0) {
        signals.push('local_mutation');
        return {
            verdict: 'allow_flagged',
            reason: 'local_mutation',
            normalizedCommand,
            fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
            assessment: {
                reversibility: 'recoverable_with_cost',
                external: false,
                blastRadius: 'this repository',
                confidence: 0.72,
                signals,
            },
        };
    }
    signals.push('unknown_local_effect');
    return {
        verdict: 'allow_flagged',
        reason: 'unknown_local_effect',
        normalizedCommand,
        fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
        assessment: {
            reversibility: 'recoverable_with_cost',
            external: false,
            blastRadius: 'this repository',
            confidence: 0.61,
            signals,
        },
    };
}
export function classifyShell(command, cwd, repoRoot, options = {}) {
    const tokens = tokenizeShell(command);
    const segments = splitSegmentsWithSeparators(tokens);
    const normalizedCommand = normalizeShellCommand(command, repoRoot, normalizeToken);
    const cwdRelative = relativeWithinRepo(repoRoot, cwd) ?? cwd;
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
        const result = classifySegment(segments[index], cwd, repoRoot, normalizedCommand, cwdRelative, options);
        effective = worseVerdict(effective, result);
        if (result.verdict === 'deny_pending_approval' && options.strictChains !== true) {
            return result;
        }
    }
    return effective;
}
