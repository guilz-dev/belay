import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { mergeConfig } from '../../core/config.js'
import { classifyShell } from '../../core/verdict/adapter.js'
import { parseSegment } from '../../core/verdict/parser.js'
import { analyzeShellCommandSemantics } from '../../core/verdict/shell-semantics.js'
import { verdict } from '../../core/verdict/verdict.js'
import { verdictTestContext } from './helpers.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')
const config = mergeConfig({})

describe('shell semantics integration', () => {
  it('allows git -C repo status as read-only', async () => {
    const result = await classifyShell(`git -C ${repoRoot} status`, cwd, repoRoot, config)
    expect(result.verdict).toBe('allow')
    expect(result.reason).toBe('read_only')
  })

  it('allows git branch feature/credentials without secret-path ask', async () => {
    const result = await classifyShell('git branch feature/credentials', cwd, repoRoot, config)
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('local_mutation')
  })

  it('requires approval for git reset --hard and git clean -fdx', async () => {
    const reset = await classifyShell('git reset --hard', cwd, repoRoot, config)
    expect(reset.verdict).toBe('deny_pending_approval')
    expect(reset.reason).toBe('git_history_destructive')

    const clean = await classifyShell('git clean -fdx', cwd, repoRoot, config)
    expect(clean.verdict).toBe('deny_pending_approval')
  })

  it('allows pnpm exec vitest after launcher expansion', async () => {
    const ctx = verdictTestContext()
    const result = await verdict('pnpm exec vitest run src/example.test.ts', ctx)
    expect(result.permission).toBe('allow')
  })

  it('allows tsc --noEmit without path operands', () => {
    const segment = parseSegment('tsc --noEmit')
    const semantics = analyzeShellCommandSemantics(segment.tokens, segment, cwd)
    expect(semantics.effect).toBe('local_mutation')
    expect(semantics.pathTargets).toEqual([])
  })

  it('treats grep and jq as read-only', () => {
    const grep = parseSegment('grep -R pattern src')
    expect(analyzeShellCommandSemantics(grep.tokens, grep, cwd).effect).toBe('read_only')

    const jq = parseSegment('jq . package.json')
    expect(analyzeShellCommandSemantics(jq.tokens, jq, cwd).effect).toBe('read_only')
  })

  it('classifies local and remote rsync differently', async () => {
    const local = await classifyShell('rsync -a src/ dest/', cwd, repoRoot, config)
    expect(local.verdict).toBe('allow_flagged')

    const remote = await classifyShell('rsync -a src/ user@host:/dest', cwd, repoRoot, config)
    expect(remote.verdict).toBe('deny_pending_approval')

    const destructive = await classifyShell('rsync -a --delete src/ dest/', cwd, repoRoot, config)
    expect(destructive.verdict).toBe('deny_pending_approval')
    expect(destructive.reason).toBe('rsync_destructive')
  })

  it('allows go test ./... as routine repo-local mutation', async () => {
    const result = await classifyShell('go test ./...', cwd, repoRoot, config)
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('local_mutation')
  })

  it('requires approval for git fetch and pull', async () => {
    const fetch = await classifyShell('git fetch origin', cwd, repoRoot, config)
    expect(fetch.verdict).toBe('deny_pending_approval')

    const pull = await classifyShell('git pull origin main', cwd, repoRoot, config)
    expect(pull.verdict).toBe('deny_pending_approval')
  })

  it('allows git reset -h without destructive ask', async () => {
    const result = await classifyShell('git reset -h', cwd, repoRoot, config)
    expect(result.verdict).not.toBe('deny_pending_approval')
  })

  it('allows rsync --delay-updates as local mutation', async () => {
    const result = await classifyShell('rsync -a --delay-updates src/ dest/', cwd, repoRoot, config)
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('local_mutation')
  })

  it('allows git checkout ref names without secret-path ask', async () => {
    const result = await classifyShell('git checkout feature/credentials', cwd, repoRoot, config)
    expect(result.verdict).toBe('allow')
    expect(result.reason).toBe('read_only')
  })

  it('allows git show ref names without secret-path ask', async () => {
    const result = await classifyShell('git show feature/credentials', cwd, repoRoot, config)
    expect(result.verdict).toBe('allow')
    expect(result.reason).toBe('read_only')
  })

  it('allows pnpm typecheck and pnpm lint via script resolution', async () => {
    const ctx = verdictTestContext()
    const typecheck = await classifyShell('pnpm typecheck', ctx.cwd, ctx.repoRoot, config)
    expect(typecheck.verdict).toBe('allow_flagged')
    expect(typecheck.reason).toBe('local_mutation')

    const lint = await classifyShell('pnpm lint', ctx.cwd, ctx.repoRoot, config)
    expect(lint.verdict).toBe('allow_flagged')
    expect(lint.reason).toBe('local_mutation')
  })
})
