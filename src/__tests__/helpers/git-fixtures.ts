import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function initializeRealGitRepository(repositoryRoot: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: repositoryRoot })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repositoryRoot,
  })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repositoryRoot })
  await writeFile(path.join(repositoryRoot, 'README.md'), '# fixture\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repositoryRoot })
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repositoryRoot })
}

export async function createRealGitRepository(tempDirs: string[], prefix: string): Promise<string> {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(repositoryRoot)
  await initializeRealGitRepository(repositoryRoot)
  return repositoryRoot
}

export async function createRealLinkedWorktree(
  tempDirs: string[],
  repositoryRoot: string,
  worktreeRoot: string,
  branchName: string,
): Promise<string> {
  tempDirs.push(worktreeRoot)
  await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreeRoot], {
    cwd: repositoryRoot,
  })
  return worktreeRoot
}

export async function createRealBareRepository(
  tempDirs: string[],
  prefix: string,
): Promise<string> {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(repositoryRoot)
  await initializeRealBareRepository(repositoryRoot)
  return repositoryRoot
}

export async function initializeRealBareRepository(repositoryRoot: string): Promise<void> {
  await execFileAsync('git', ['init', '--bare'], { cwd: repositoryRoot })
}
