import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const READ_ONLY_GIT_COMMANDS = new Set([
    'rev-parse --is-inside-work-tree',
    'status --porcelain',
    'reflog -n 10',
]);
export function isReadOnlyGitProbe(commandKey) {
    return READ_ONLY_GIT_COMMANDS.has(commandKey);
}
async function runGit(repoRoot, args) {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        });
        return { ok: true, stdout: stdout.trimEnd() };
    }
    catch {
        return { ok: false, stdout: '' };
    }
}
export async function probeGitState(repoRoot) {
    const notes = [];
    const workTree = await runGit(repoRoot, ['rev-parse', '--is-inside-work-tree']);
    if (!workTree.ok || workTree.stdout !== 'true') {
        return {
            inWorkTree: false,
            notes: ['Not a git work tree — file-level git restore advice may not apply.'],
        };
    }
    const status = await runGit(repoRoot, ['status', '--porcelain']);
    if (status.ok) {
        notes.push('Read git status (porcelain) for context.');
    }
    const reflog = await runGit(repoRoot, ['reflog', '-n', '10']);
    if (reflog.ok) {
        notes.push('Read recent reflog entries for context.');
    }
    return {
        inWorkTree: true,
        porcelain: status.ok ? status.stdout : undefined,
        reflog: reflog.ok ? reflog.stdout : undefined,
        notes,
    };
}
