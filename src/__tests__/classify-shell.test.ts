import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyShell } from '../core/classify-shell.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')

describe('classifyShell', () => {
  it('allows read-only commands', () => {
    const result = classifyShell('rg plan src', cwd, repoRoot)
    expect(result.verdict).toBe('allow')
    expect(result.reason).toBe('read_only')
  })

  it('flags local mutations', () => {
    const result = classifyShell('touch notes.txt', cwd, repoRoot)
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('local_mutation')
  })

  it('denies external commands', () => {
    const result = classifyShell('git push origin main', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('external_effect')
  })

  it('denies chained external commands after read-only segments', () => {
    const result = classifyShell('git status && git push origin main', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
  })

  it('denies pipe to shell interpreter', () => {
    const result = classifyShell('echo hi | bash', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('pipe_to_shell')
  })

  it('denies outside repo redirects', () => {
    const result = classifyShell('echo hi > ../outside.txt', repoRoot, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('outside_repo_redirect')
  })

  it('denies npm run deploy scripts', () => {
    const result = classifyShell('npm run deploy:prod', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('external_script')
  })

  it('flags curl with authorization headers', () => {
    const result = classifyShell(
      'curl -H "Authorization: Bearer secret" https://api.example.com',
      cwd,
      repoRoot,
    )
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('credential_header')
  })

  it('denies docker run', () => {
    const result = classifyShell('docker run node:22 node -v', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
  })

  it('denies terraform apply', () => {
    const result = classifyShell('terraform apply -auto-approve', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
  })

  it('respects custom allow commands', () => {
    const result = classifyShell('pnpm release:staging', cwd, repoRoot, {
      customAllowCommands: ['pnpm release:staging'],
    })
    expect(result.verdict).toBe('allow')
    expect(result.reason).toBe('custom_allow')
  })

  it('respects custom external commands', () => {
    const result = classifyShell('./scripts/release.sh', cwd, repoRoot, {
      customExternalCommands: ['./scripts/release.sh'],
    })
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('custom_external')
  })

  it('includes assessment signals', () => {
    const result = classifyShell('git push origin main', cwd, repoRoot)
    expect(result.assessment.signals.length).toBeGreaterThan(0)
  })
})
