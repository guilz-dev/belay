import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
function execGit(repoRoot, args) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['-C', repoRoot, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve(Buffer.concat(stdout).toString('utf8'));
                return;
            }
            reject(new Error(`git ${args.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf8').trim()}`));
        });
    });
}
export async function isGitWorktreeAvailable(repoRoot) {
    try {
        await execGit(repoRoot, ['rev-parse', '--git-dir']);
        return true;
    }
    catch {
        return false;
    }
}
export async function createGitWorktreeSnapshot(repoRoot, stateDir) {
    const worktreePath = path.join(stateDir, `tx-${randomUUID().replaceAll('-', '')}`);
    await mkdir(stateDir, { recursive: true });
    await execGit(repoRoot, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);
    return {
        worktreePath,
        cleanup: async () => {
            try {
                await execGit(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
            }
            catch {
                await rm(worktreePath, { recursive: true, force: true });
                try {
                    await execGit(repoRoot, ['worktree', 'prune']);
                }
                catch {
                    // best effort
                }
            }
        },
    };
}
export function resolveWorktreeCwd(repoRoot, worktreePath, cwd) {
    const resolvedCwd = path.resolve(cwd);
    const relative = path.relative(path.resolve(repoRoot), resolvedCwd);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return worktreePath;
    }
    if (relative === '') {
        return worktreePath;
    }
    return path.join(worktreePath, relative);
}
export function runShellCommand(command, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(command, {
            cwd,
            shell: true,
            stdio: 'ignore',
            env: process.env,
        });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, timeoutMs);
        child.on('error', () => {
            clearTimeout(timer);
            resolve({ exitCode: 1, signal: null, timedOut });
        });
        child.on('close', (exitCode, signal) => {
            clearTimeout(timer);
            resolve({
                exitCode,
                signal: signal ? String(signal) : null,
                timedOut,
            });
        });
    });
}
function parseStatusLine(line) {
    if (line.length < 4) {
        return null;
    }
    const status = line.slice(0, 2);
    const relativePath = line.slice(3).trim();
    if (!relativePath) {
        return null;
    }
    if (status.includes('D')) {
        return { relativePath, kind: 'deleted' };
    }
    if (status === '??') {
        return { relativePath, kind: 'added' };
    }
    if (status.includes('A') || status.includes('?')) {
        return { relativePath, kind: 'added' };
    }
    return { relativePath, kind: 'modified' };
}
export async function collectWorktreeChanges(worktreePath) {
    const status = await execGit(worktreePath, ['status', '--porcelain']);
    const changes = [];
    const seen = new Set();
    for (const line of status.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        const change = parseStatusLine(line);
        if (!change || seen.has(change.relativePath)) {
            continue;
        }
        seen.add(change.relativePath);
        changes.push(change);
    }
    return changes;
}
export async function applyWorktreeChanges(worktreePath, repoRoot, changes) {
    for (const change of changes) {
        const target = path.join(repoRoot, change.relativePath);
        if (change.kind === 'deleted') {
            await rm(target, { force: true });
            continue;
        }
        const source = path.join(worktreePath, change.relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
    }
}
