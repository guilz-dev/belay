import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { collectOutsideRepoPaths } from '../core/capability/paths.js'
import { canonicalPath } from '../core/path-utils.js'
import {
  extractRedirectTargets,
  lexShell,
  splitTopLevelSegments,
  tokenizeShell,
} from '../core/shell-tokenizer.js'
import { classifyShellCore } from './helpers/shell-classify.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')
const outsideTmpLog = canonicalPath('/tmp/out.log')
const outsideTmpIn = canonicalPath('/tmp/in.txt')

describe('tokenizeShell', () => {
  it('preserves quote parts, spans, and an empty quoted word', () => {
    const lexed = lexShell(`sh -c ''`)

    expect(lexed.complete).toBe(true)
    expect(lexed.tokens).toHaveLength(3)
    expect(lexed.tokens[2]).toEqual(
      expect.objectContaining({ kind: 'word', value: '', raw: "''", start: 6, end: 8 }),
    )
    expect(tokenizeShell(`sh -c ''`)).toEqual(['sh', '-c', ''])
  })

  it('keeps backslash literal in single quotes', () => {
    expect(tokenizeShell(`printf '%s' 'a\\b'`)).toEqual(['printf', '%s', 'a\\b'])
  })

  it('only consumes portable escapes inside double quotes', () => {
    expect(tokenizeShell(String.raw`printf "%s" "a\qb\"c"`)).toEqual(['printf', '%s', 'a\\qb"c'])
  })

  it('records expansion only outside single quotes', () => {
    const words = lexShell(`sh -c '$CMD' "$CMD"`).tokens.filter((token) => token.kind === 'word')

    expect(words[2]?.parts.some((part) => part.hasExpansion)).toBe(false)
    expect(words[3]?.parts.some((part) => part.hasExpansion)).toBe(true)
  })

  it.each([`echo 'unterminated`, `echo trailing\\`])('marks incomplete lexing: %s', (command) => {
    expect(lexShell(command).complete).toBe(false)
  })

  it('splits top-level background operators with or without surrounding spaces', () => {
    expect(splitTopLevelSegments(tokenizeShell('git push origin main & echo done'))).toEqual([
      ['git', 'push', 'origin', 'main'],
      ['echo', 'done'],
    ])
    expect(splitTopLevelSegments(tokenizeShell('echo done&git push origin main'))).toEqual([
      ['echo', 'done'],
      ['git', 'push', 'origin', 'main'],
    ])
    expect(splitTopLevelSegments(tokenizeShell('echo done&rm -rf /etc/important'))).toEqual([
      ['echo', 'done'],
      ['rm', '-rf', '/etc/important'],
    ])
    expect(splitTopLevelSegments(tokenizeShell('sleep 1&rm -rf ~'))).toEqual([
      ['sleep', '1'],
      ['rm', '-rf', '~'],
    ])
  })

  it('keeps canonical redirect tokens and targets aligned', () => {
    expect(tokenizeShell('echo hi > out.log')).toEqual(['echo', 'hi', '>', 'out.log'])
    expect(tokenizeShell('echo hi 1> out.log')).toEqual(['echo', 'hi', '1>', 'out.log'])
    expect(tokenizeShell('echo hi 2> err.log')).toEqual(['echo', 'hi', '2>', 'err.log'])
    expect(tokenizeShell('echo hi 3> out.log')).toEqual(['echo', 'hi', '3>', 'out.log'])
    expect(tokenizeShell('echo hi 1>> out.log')).toEqual(['echo', 'hi', '1>>', 'out.log'])
    expect(tokenizeShell('echo hi 2>> err.log')).toEqual(['echo', 'hi', '2>>', 'err.log'])
    expect(tokenizeShell('echo hi 12>> err.log')).toEqual(['echo', 'hi', '12>>', 'err.log'])
    expect(tokenizeShell('echo hi 12>>err.log')).toEqual(['echo', 'hi', '12>>', 'err.log'])
    expect(tokenizeShell('echo hi &> all.log')).toEqual(['echo', 'hi', '&>', 'all.log'])
    expect(tokenizeShell('echo hi 2>&1')).toEqual(['echo', 'hi', '2>&1'])
    expect(tokenizeShell('echo hi 2>&-')).toEqual(['echo', 'hi', '2>&-'])
    expect(tokenizeShell('echo hi 3>&1')).toEqual(['echo', 'hi', '3>&1'])
    expect(tokenizeShell('echo hi &>/tmp/out.log')).toEqual(['echo', 'hi', '&>', '/tmp/out.log'])
    expect(tokenizeShell('cat 3< in.txt')).toEqual(['cat', '3<', 'in.txt'])
    expect(tokenizeShell('cat 3</tmp/in.txt')).toEqual(['cat', '3<', '/tmp/in.txt'])
    expect(tokenizeShell('cat 12<foo')).toEqual(['cat', '12<', 'foo'])
    expect(tokenizeShell('echo hi 3<&1')).toEqual(['echo', 'hi', '3<&1'])
    expect(tokenizeShell('echo hi 3<&-')).toEqual(['echo', 'hi', '3<&-'])
    expect(tokenizeShell('echo hi 12<&1')).toEqual(['echo', 'hi', '12<&1'])
    expect(tokenizeShell('echo hi 12<&-')).toEqual(['echo', 'hi', '12<&-'])
    expect(tokenizeShell('cat < /tmp/in.txt')).toEqual(['cat', '<', '/tmp/in.txt'])
  })
})

describe('extractRedirectTargets', () => {
  it('collects file redirect targets but skips fd duplication', () => {
    expect(extractRedirectTargets(tokenizeShell('echo hi > out.log'))).toEqual(['out.log'])
    expect(extractRedirectTargets(tokenizeShell('echo hi 1> out.log'))).toEqual(['out.log'])
    expect(extractRedirectTargets(tokenizeShell('echo hi 2> err.log'))).toEqual(['err.log'])
    expect(extractRedirectTargets(tokenizeShell('echo hi 3> out.log'))).toEqual(['out.log'])
    expect(extractRedirectTargets(tokenizeShell('echo hi 1>> out.log'))).toEqual(['out.log'])
    expect(extractRedirectTargets(tokenizeShell('echo hi 2>> err.log'))).toEqual(['err.log'])
    expect(extractRedirectTargets(tokenizeShell('echo hi 12>> err.log'))).toEqual(['err.log'])
    expect(extractRedirectTargets(tokenizeShell('echo hi 12>>err.log'))).toEqual(['err.log'])
    expect(extractRedirectTargets(tokenizeShell('echo hi &> all.log'))).toEqual(['all.log'])
    expect(extractRedirectTargets(tokenizeShell('echo hi 2>&1'))).toEqual([])
    expect(extractRedirectTargets(tokenizeShell('echo hi 2>&-'))).toEqual([])
    expect(extractRedirectTargets(tokenizeShell('echo hi 3>&1'))).toEqual([])
    expect(extractRedirectTargets(tokenizeShell('cat 3< in.txt'))).toEqual(['in.txt'])
    expect(extractRedirectTargets(tokenizeShell('cat 3</tmp/in.txt'))).toEqual(['/tmp/in.txt'])
    expect(extractRedirectTargets(tokenizeShell('cat 12<foo'))).toEqual(['foo'])
    expect(extractRedirectTargets(tokenizeShell('echo hi 3<&1'))).toEqual([])
    expect(extractRedirectTargets(tokenizeShell('echo hi 3<&-'))).toEqual([])
    expect(extractRedirectTargets(tokenizeShell('echo hi 12<&1'))).toEqual([])
    expect(extractRedirectTargets(tokenizeShell('echo hi 12<&-'))).toEqual([])
    expect(extractRedirectTargets(tokenizeShell('cat < /tmp/in.txt'))).toEqual(['/tmp/in.txt'])
  })
})

describe('collectOutsideRepoPaths', () => {
  it('keeps repo-outside redirect detection for &> targets', () => {
    expect(collectOutsideRepoPaths('echo hi &>/tmp/out.log', cwd, repoRoot)).toEqual([
      outsideTmpLog,
    ])
  })

  it('collects generic fd redirects without treating the operator as a path', () => {
    expect(collectOutsideRepoPaths('echo hi 3>/tmp/out.log', cwd, repoRoot)).toEqual([
      outsideTmpLog,
    ])
  })

  it('collects input redirects to repo-outside files but skips fd duplication', () => {
    expect(collectOutsideRepoPaths('cat 3</tmp/in.txt', cwd, repoRoot)).toEqual([outsideTmpIn])
    expect(collectOutsideRepoPaths('echo hi 3<&1', cwd, repoRoot)).toEqual([])
    expect(collectOutsideRepoPaths('echo hi 3<&-', cwd, repoRoot)).toEqual([])
    expect(collectOutsideRepoPaths('echo hi 12<&-', cwd, repoRoot)).toEqual([])
    expect(collectOutsideRepoPaths('cat < /tmp/in.txt', cwd, repoRoot)).toEqual([outsideTmpIn])
  })
})

describe('classifyShell background segmentation', () => {
  it('denies backgrounded external commands without relying on spaces', async () => {
    const spaced = await classifyShellCore('git push origin main & echo done', cwd, repoRoot)
    expect(spaced.verdict).toBe('deny_pending_approval')

    const noSpace = await classifyShellCore('echo done&git push origin main', cwd, repoRoot)
    expect(noSpace.verdict).toBe('deny_pending_approval')
    expect(noSpace.reason).toBe('external_effect')
  })

  it('denies destructive commands chained with background operators', async () => {
    const repoDelete = await classifyShellCore('echo done&rm -rf ../.git', cwd, repoRoot)
    expect(repoDelete.verdict).toBe('deny_pending_approval')

    const homeDelete = await classifyShellCore('sleep 1&rm -rf ~', cwd, repoRoot)
    expect(homeDelete.verdict).toBe('deny_pending_approval')
  })

  it('does not treat fd duplication as a redirect path target', async () => {
    const result = await classifyShellCore('echo hi 2>&1', cwd, repoRoot)
    expect(result.verdict).toBe('allow')
    expect(result.reason).toBe('read_only')

    const closedFd = await classifyShellCore('echo hi 2>&-', cwd, repoRoot)
    expect(closedFd.verdict).toBe('allow')
    expect(closedFd.reason).toBe('read_only')

    const altFd = await classifyShellCore('echo hi 3>&1', cwd, repoRoot)
    expect(altFd.verdict).toBe('allow')
    expect(altFd.reason).toBe('read_only')

    const inputDup = await classifyShellCore('echo hi 3<&1', cwd, repoRoot)
    expect(inputDup.verdict).toBe('allow')
    expect(inputDup.reason).toBe('read_only')

    const inputClose = await classifyShellCore('echo hi 3<&-', cwd, repoRoot)
    expect(inputClose.verdict).toBe('allow')
    expect(inputClose.reason).toBe('read_only')

    const multiDigitClose = await classifyShellCore('echo hi 12<&-', cwd, repoRoot)
    expect(multiDigitClose.verdict).toBe('allow')
    expect(multiDigitClose.reason).toBe('read_only')
  })

  it('treats generic fd redirects as outside-repo mutation requiring approval', async () => {
    const result = await classifyShellCore('echo hi 3>/tmp/out.log', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('outside_repo_mutation')
  })

  it('treats input redirects as file targets only for read-only heads', async () => {
    const inputRedirect = await classifyShellCore('cat 3</tmp/in.txt', cwd, repoRoot)
    expect(inputRedirect.verdict).toBe('allow')
    expect(inputRedirect.reason).toBe('read_only')

    const multiDigitInput = await classifyShellCore('cat 12<foo', cwd, repoRoot)
    expect(multiDigitInput.verdict).toBe('allow')
    expect(multiDigitInput.reason).toBe('read_only')

    const plainInputRedirect = await classifyShellCore('cat < /tmp/in.txt', cwd, repoRoot)
    expect(plainInputRedirect.verdict).toBe('allow')
    expect(plainInputRedirect.reason).toBe('read_only')

    const echoInputRedirect = await classifyShellCore('echo 3</tmp/in.txt', cwd, repoRoot)
    expect(echoInputRedirect.verdict).toBe('allow')
    expect(echoInputRedirect.reason).toBe('read_only')
  })
})
