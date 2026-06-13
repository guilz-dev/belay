export const RECOVER_DISCLAIMER = [
    'Advisory only — belay does not run recovery commands.',
    'Advice is based on what belay observed through hooks; actions outside hook scope may not be visible.',
    'Recovery commands themselves pass through belay hooks — destructive undo steps may be blocked again.',
];
export const SHOW_DONT_RUN_LEAD = 'These steps may help undo the observed effect — confirm each step before running:';
const IRREVERSIBLE_REASON_PREFIXES = ['tier0_'];
const IRREVERSIBLE_REASONS = new Set([
    'external_effect',
    'exfiltration',
    'force_push',
    'remote_destructive',
]);
const DENIED_RECOVERY_PATTERNS = [
    /reset\s+--hard/i,
    /push\s+--force/i,
    /clean\s+-[a-z]*f/i,
    /dropdb\b/i,
    /destroy\b/i,
];
export function containsDeniedRecoveryPattern(text) {
    return DENIED_RECOVERY_PATTERNS.some((pattern) => pattern.test(text));
}
function isIrreversibleTarget(target) {
    if (target.effect === 'external_effect') {
        return true;
    }
    if (target.assessment?.reversibility === 'irreversible') {
        return true;
    }
    if (target.assessment?.external) {
        return true;
    }
    if (IRREVERSIBLE_REASONS.has(target.reason)) {
        return true;
    }
    for (const prefix of IRREVERSIBLE_REASON_PREFIXES) {
        if (target.reason.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}
function extractPathHints(summary) {
    const hints = new Set();
    const patterns = [
        /\b(?:git\s+)?restore\s+--\s+(\S+)/i,
        /\b(?:git\s+)?checkout\s+--\s+(\S+)/i,
        /\brm\s+(?:-[a-z]+\s+)*([^\s;&|]+)/i,
        /\b(?:edit|write|delete)\s+(\S+)/i,
    ];
    for (const pattern of patterns) {
        const match = summary.match(pattern);
        if (match?.[1] && !match[1].startsWith('-')) {
            hints.add(match[1]);
        }
    }
    return [...hints];
}
function localMutationAdvice(target, git) {
    const advice = [];
    const paths = extractPathHints(target.summary);
    if (git?.inWorkTree) {
        if (paths.length > 0) {
            for (const filePath of paths.slice(0, 3)) {
                advice.push(`git restore -- ${filePath}`);
            }
        }
        else {
            advice.push('git status --porcelain  # inspect changed paths first');
            advice.push('git restore -- <path>  # restore specific tracked files');
        }
        if (/commit/i.test(target.summary) || target.reason.includes('commit')) {
            advice.push('git log -n 5  # identify the commit to revert');
            advice.push('git revert <commit>  # prefer revert over reset for shared history');
        }
        if (git.reflog) {
            advice.push('git reflog -n 10  # locate a prior HEAD if a local commit was lost');
        }
    }
    else {
        advice.push('Restore from version control or backups if the change was not committed.');
        if (paths.length > 0) {
            advice.push(`Check backups or trash for: ${paths.join(', ')}`);
        }
    }
    return advice.filter((line) => !containsDeniedRecoveryPattern(line));
}
export function buildRecoverAdvice(input) {
    const { target, git } = input;
    const warnings = [];
    const disclaimer = [...RECOVER_DISCLAIMER];
    if (isIrreversibleTarget(target)) {
        return {
            recoverable: false,
            confidence: 'high',
            disclaimer,
            advice: [
                'This action is likely not recoverable through local undo.',
                'External or irreversible effects (publish, remote delete, force-push, exfiltration, etc.) cannot be reliably reversed.',
                'Treat this as incident response: revoke credentials, notify stakeholders, and follow your org runbook.',
            ],
            warnings: [
                'Belay blocked this because it looked catastrophic and irreversible — do not expect a safe automatic undo.',
            ],
        };
    }
    if (target.effect === 'read_only') {
        return {
            recoverable: true,
            confidence: 'high',
            disclaimer,
            advice: ['No local mutation was recorded — there may be nothing to undo.'],
            warnings: [],
        };
    }
    const advice = [SHOW_DONT_RUN_LEAD];
    if (target.effect === 'local_mutation' || target.assessment?.reversibility === 'recoverable_with_cost') {
        advice.push(...localMutationAdvice(target, git));
    }
    else if (inferWouldBlockFromTarget(target)) {
        advice.push(...localMutationAdvice(target, git));
        warnings.push('Effect axis was unclear — showing conservative file/git guidance only.');
    }
    else {
        return {
            recoverable: false,
            confidence: 'medium',
            disclaimer,
            advice: [
                'Insufficient signal to suggest a safe recovery path.',
                'Review the audit entry and your VCS or backups manually before attempting undo steps.',
            ],
            warnings: ['Low confidence — no specific recovery commands are suggested.'],
        };
    }
    const filteredAdvice = advice.filter((line) => !containsDeniedRecoveryPattern(line));
    if (filteredAdvice.length <= 1) {
        return {
            recoverable: false,
            confidence: 'medium',
            disclaimer,
            advice: [
                'No safe, specific recovery command can be suggested from the observed audit record.',
                'Inspect git history, backups, or hosting provider recovery tools manually.',
            ],
            warnings: warnings.length > 0 ? warnings : ['Low confidence — no specific recovery commands are suggested.'],
        };
    }
    return {
        recoverable: true,
        confidence: git?.inWorkTree ? 'high' : 'medium',
        disclaimer,
        advice: filteredAdvice,
        warnings,
    };
}
function inferWouldBlockFromTarget(target) {
    return (target.permission === 'ask' ||
        target.reason.startsWith('tier0_') ||
        target.reason === 'unknown_local_effect');
}
