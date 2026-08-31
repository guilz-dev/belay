import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as cwdResolution from '../adapters/cursor/cwd-resolution.js'
import { resolveCursorActionCwd } from '../adapters/cursor/runtime-entry.js'
import {
  approvedApprovalsPath,
  loadApprovalState,
  loadConfigFile,
  pendingApprovalsPath,
} from '../config-io.js'
import { mergeConfig } from '../core/config.js'
import { scrubString } from '../core/scrub.js'
import { writeRuntimeArtifacts } from '../installer/runtime-artifacts.js'
import { initProject } from '../installer.js'
import { PACKAGE_VERSION } from '../version.js'
import { classifyShellGated } from './helpers/shell-classify.js'

const tempDirs: string[] = []
const tempFiles: string[] = []
const HOST_RUNTIME_PROCESS_TEST_TIMEOUT_MS = 15_000
const execFileAsync = promisify(execFile)

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-runtime-'))
  tempDirs.push(tempDir)
  return tempDir
}

async function initIsolatedRepo() {
  const repoRoot = await createTempRepo()
  await initProject({ targetDir: repoRoot })
  const config = mergeConfig({
    ...(await loadConfigFile(repoRoot)),
    controlPlane: {
      enabled: true,
      configDir: path.join(repoRoot, '.belay-cp'),
      integrity: 'hash-pinned',
    },
    audit: { logPath: '.cursor/belay/audit.ndjson', includeAssessment: true },
  })
  await writeFile(
    path.join(repoRoot, '.cursor', 'belay.config.json'),
    `${JSON.stringify(
      mergeConfig({
        ...config,
        mode: 'enforce',
      }),
      null,
      2,
    )}\n`,
  )
  return repoRoot
}

async function runRunner(
  repoRoot: string,
  hookName: string,
  payload: unknown,
  extraArgs: string[] = [],
  cwd = repoRoot,
) {
  const runnerPath = path.join(repoRoot, '.cursor', 'hooks', 'belay-runner')
  const args = [hookName, ...extraArgs]
  const child = spawn(runnerPath, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  child.stdin.write(JSON.stringify(payload))
  child.stdin.end()

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })

  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8').trim(),
    stderr: Buffer.concat(stderr).toString('utf8').trim(),
  }
}

async function readJson(filePath: string) {
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

async function auditLogPath(repoRoot: string): Promise<string> {
  const config = await loadConfigFile(repoRoot)
  return path.join(repoRoot, config.audit.logPath)
}

async function runHookScript(
  scriptPath: string,
  input: string,
  coreMarkerPath: string,
  extraArgs: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [scriptPath, ...extraArgs], {
    env: { ...process.env, BELAY_CORE_IMPORT_MARKER: coreMarkerPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  child.stdin.end(input)

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8').trim(),
    stderr: Buffer.concat(stderr).toString('utf8').trim(),
  }
}

async function coreMarkerLoadCount(markerPath: string): Promise<number> {
  try {
    return (await readFile(markerPath, 'utf8')).trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

describe('generated hook runtime', () => {
  beforeEach(() => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
  })

  afterEach(async () => {
    delete process.env.BELAY_DETERMINISTIC_JUDGE
    delete process.env.BELAY_TEST_APPROVAL_REPLAY
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    await Promise.all(tempFiles.splice(0).map((file) => rm(file, { force: true })))
  })

  it('loads core exactly once for the owner and never for a non-owner', async () => {
    const repoRoot = await initIsolatedRepo()
    const globalRoot = await createTempRepo()
    const globalHooksDir = path.join(globalRoot, '.cursor', 'hooks')
    const globalRuntimeDir = path.join(globalRoot, '.cursor', 'belay', 'runtime')
    await writeRuntimeArtifacts('cursor', {
      scope: 'global',
      repoRoot,
      configPath: path.join(repoRoot, '.cursor', 'belay.config.json'),
      hooksSettingsPath: path.join(globalRoot, '.cursor', 'hooks.json'),
      hooksDir: globalHooksDir,
      runtimeDir: globalRuntimeDir,
      repoLocalStateDir: path.join(repoRoot, '.cursor', 'belay'),
      skillsDir: path.join(globalRoot, '.cursor', 'skills', 'belay'),
    })

    const markerCore = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.BELAY_CORE_IMPORT_MARKER, 'loaded\\n')
const write = (response) => process.stdout.write(JSON.stringify(response) + '\\n')
export async function handleBeforeSubmitPromptHook() { return { continue: true } }
export async function handleShellGateHook() { return { permission: 'allow' } }
export async function handleToolGateHook() { return { permission: 'allow' } }
export async function handleAuditHook() { return {} }
export async function runBeforeSubmitPromptHook() { write({ continue: true }) }
export async function runShellGateHook() { write({ permission: 'allow' }) }
export async function runToolGateHook() { write({ permission: 'allow' }) }
export async function runAuditHook() { write({}) }
`
    const projectRuntimeDir = path.join(repoRoot, '.cursor', 'belay', 'runtime')
    await writeFile(path.join(projectRuntimeDir, 'core.mjs'), markerCore)
    await writeFile(path.join(globalRuntimeDir, 'core.mjs'), markerCore)

    const nonOwnerMarker = path.join(globalRoot, 'non-owner-core-loads.txt')
    const ownerMarker = path.join(globalRoot, 'owner-core-loads.txt')
    const payload = { command: 'git status', cwd: repoRoot }
    const nonOwnerCases = [
      ['belay-before-submit.mjs', [], { continue: true }],
      ['belay-shell-gate.mjs', [], { permission: 'allow' }],
      ['belay-tool-gate.mjs', ['preToolUse'], { permission: 'allow' }],
      ['belay-audit.mjs', ['postToolUse'], {}],
    ] as const
    for (const [hookName, args, expected] of nonOwnerCases) {
      const nonOwner = await runHookScript(
        path.join(globalHooksDir, hookName),
        JSON.stringify(payload),
        nonOwnerMarker,
        [...args],
      )
      expect(nonOwner.exitCode).toBe(0)
      expect(JSON.parse(nonOwner.stdout)).toEqual(expected)
    }
    const owner = await runHookScript(
      path.join(repoRoot, '.cursor', 'hooks', 'belay-shell-gate.mjs'),
      JSON.stringify(payload),
      ownerMarker,
    )

    expect(await coreMarkerLoadCount(nonOwnerMarker)).toBe(0)
    expect(owner.exitCode).toBe(0)
    expect(JSON.parse(owner.stdout)).toEqual({ permission: 'allow' })
    expect(await coreMarkerLoadCount(ownerMarker)).toBe(1)
  })

  it('rejects malformed gate input without loading core and keeps audit input safe', async () => {
    const repoRoot = await initIsolatedRepo()
    const runtimeDir = path.join(repoRoot, '.cursor', 'belay', 'runtime')
    const markerPath = path.join(repoRoot, 'malformed-core-loads.txt')
    await writeFile(
      path.join(runtimeDir, 'core.mjs'),
      `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.BELAY_CORE_IMPORT_MARKER, 'loaded\\n')
export async function runShellGateHook() { process.stdout.write('{"permission":"allow"}\\n') }
export async function runAuditHook() { process.stdout.write('{}\\n') }
`,
    )

    const gate = await runHookScript(
      path.join(repoRoot, '.cursor', 'hooks', 'belay-shell-gate.mjs'),
      '{not-json',
      markerPath,
    )
    const audit = await runHookScript(
      path.join(repoRoot, '.cursor', 'hooks', 'belay-audit.mjs'),
      '{not-json',
      markerPath,
      ['postToolUse'],
    )

    expect(gate.exitCode).toBe(0)
    expect(JSON.parse(gate.stdout)).toMatchObject({ permission: 'deny' })
    expect(audit.exitCode).toBe(0)
    expect(JSON.parse(audit.stdout)).toEqual({})
    expect(await coreMarkerLoadCount(markerPath)).toBe(0)
  })

  it('fails closed for an incomplete project owner while keeping audit safe', async () => {
    const repoRoot = await initIsolatedRepo()
    const runtimeDir = path.join(repoRoot, '.cursor', 'belay', 'runtime')
    const markerPath = path.join(repoRoot, 'incomplete-core-loads.txt')
    await rm(path.join(runtimeDir, 'core.mjs'))
    const payload = JSON.stringify({ command: 'git status', cwd: repoRoot })

    const gate = await runHookScript(
      path.join(repoRoot, '.cursor', 'hooks', 'belay-shell-gate.mjs'),
      payload,
      markerPath,
    )
    const audit = await runHookScript(
      path.join(repoRoot, '.cursor', 'hooks', 'belay-audit.mjs'),
      payload,
      markerPath,
      ['postToolUse'],
    )

    expect(gate.exitCode).toBe(0)
    expect(JSON.parse(gate.stdout)).toEqual({
      permission: 'deny',
      user_message: 'belay project hook installation is incomplete.',
    })
    expect(audit.exitCode).toBe(0)
    expect(JSON.parse(audit.stdout)).toEqual({})
    expect(await coreMarkerLoadCount(markerPath)).toBe(0)
  })

  it('returns the current before-submit response from a parsed payload handler', async () => {
    const repoRoot = await initIsolatedRepo()
    const runtime = (await import('../adapters/cursor/runtime-entry.js')) as unknown as {
      handleBeforeSubmitPromptHook(payload: Record<string, unknown>): Promise<unknown>
    }

    await expect(
      runtime.handleBeforeSubmitPromptHook({ prompt: 'continue working', cwd: repoRoot }),
    ).resolves.toEqual({ continue: true })
  })

  it('returns the current shell-gate response from a parsed payload handler', async () => {
    const repoRoot = await initIsolatedRepo()
    const runtime = (await import('../adapters/cursor/runtime-entry.js')) as unknown as {
      handleShellGateHook(payload: Record<string, unknown>): Promise<unknown>
    }

    await expect(
      runtime.handleShellGateHook({ command: 'git status', cwd: repoRoot }),
    ).resolves.toEqual({ permission: 'allow' })
  })

  it('returns the current tool-gate response from a parsed payload handler', async () => {
    const repoRoot = await initIsolatedRepo()
    const runtime = (await import('../adapters/cursor/runtime-entry.js')) as unknown as {
      handleToolGateHook(eventName: string, payload: Record<string, unknown>): Promise<unknown>
    }

    await expect(
      runtime.handleToolGateHook('preToolUse', { tool_name: 'Read', cwd: repoRoot }),
    ).resolves.toEqual({ permission: 'allow' })
  })

  it('returns the current audit response from a parsed payload handler', async () => {
    const repoRoot = await initIsolatedRepo()
    const runtime = (await import('../adapters/cursor/runtime-entry.js')) as unknown as {
      handleAuditHook(eventName: string, payload: Record<string, unknown>): Promise<unknown>
    }

    await expect(
      runtime.handleAuditHook('postToolUse', { tool_name: 'Read', cwd: repoRoot }),
    ).resolves.toEqual({})
  })

  it.each([
    [
      'Shell tool working directory',
      { tool_input: { working_directory: 'shell-action' } },
      path.resolve('shell-action'),
    ],
    ['top-level cwd', { cwd: 'top-level-action' }, path.resolve('top-level-action')],
    [
      'first non-empty workspace root',
      { workspace_roots: ['', 1, null, 'workspace-action', 'later-workspace'] },
      path.resolve('workspace-action'),
    ],
    ['fallback', {}, path.resolve('fallback-action')],
    [
      'malformed nested tool input',
      { tool_input: 'not-an-object', cwd: 'top-level-action' },
      path.resolve('top-level-action'),
    ],
    [
      'empty higher-precedence values',
      {
        tool_input: { working_directory: '' },
        cwd: '',
        workspace_roots: ['', false, 'workspace-action'],
      },
      path.resolve('workspace-action'),
    ],
    [
      'all source values differ',
      {
        tool_input: { working_directory: 'shell-action' },
        cwd: 'top-level-action',
        workspace_roots: ['workspace-action'],
      },
      path.resolve('shell-action'),
    ],
  ])('resolves Cursor action cwd from %s', (_caseName, payload, expected) => {
    expect(resolveCursorActionCwd(payload, 'fallback-action')).toBe(expected)
  })

  it('marks payload-free fallback as unsafe for global hook runtime', () => {
    const resolution = cwdResolution.resolveCursorActionCwdDetails({}, 'fallback-action')
    expect(cwdResolution.isUnsafeGlobalHookFallback(resolution, true)).toBe(true)
    expect(cwdResolution.GLOBAL_HOOK_WORKSPACE_MISSING_MESSAGE).toContain(
      'belay uninstall --scope global',
    )
  })

  it('allows payload-derived cwd for global hook runtime', () => {
    const resolution = cwdResolution.resolveCursorActionCwdDetails(
      { cwd: 'workspace-action' },
      'fallback-action',
    )
    expect(cwdResolution.isUnsafeGlobalHookFallback(resolution, true)).toBe(false)
    expect(resolution.source).toBe('cwd')
  })

  it('uses the Shell action working directory for Make policy and approval state', async () => {
    const parentRoot = await initIsolatedRepo()
    const childRoot = path.join(parentRoot, 'linked-workspace')
    await initProject({ targetDir: childRoot })
    await execFileAsync('git', ['init', '--quiet'], { cwd: parentRoot })
    await execFileAsync('git', ['init', '--quiet'], { cwd: childRoot })
    const childConfig = mergeConfig({
      ...(await loadConfigFile(childRoot)),
      mode: 'enforce',
      controlPlane: {
        enabled: true,
        configDir: path.join(childRoot, '.belay-cp'),
        integrity: 'hash-pinned',
      },
      audit: { logPath: '.cursor/belay/audit.ndjson', includeAssessment: true },
    })
    await writeFile(
      path.join(childRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(childConfig, null, 2)}\n`,
    )
    await writeFile(path.join(parentRoot, 'Makefile'), 'harmless:\n\t@printf parent\\n\n')
    await writeFile(
      path.join(childRoot, 'Makefile'),
      'guarded: container-push\n\ncontainer-push:\n\tdocker push example/guarded:latest\n',
    )

    const result = await runRunner(
      childRoot,
      'belay-tool-gate',
      {
        tool_name: 'Shell',
        tool_input: {
          command: 'make guarded',
          working_directory: childRoot,
        },
        cwd: parentRoot,
        workspace_roots: [parentRoot, childRoot],
      },
      ['preToolUse'],
      parentRoot,
    )

    expect(JSON.parse(result.stdout)).toMatchObject({ permission: 'deny' })
    const pending = await loadApprovalState(childRoot, 'pending-approvals.json', childConfig)
    expect(pending.approvals).toHaveLength(1)
    expect(pending.approvals[0]).toMatchObject({
      kind: 'shell',
      input: 'make guarded',
      inputKind: 'shell',
      repoRoot: childRoot,
      cwd: childRoot,
    })
    const auditLines = (await readFile(await auditLogPath(childRoot), 'utf8')).trim().split('\n')
    const auditRecord = JSON.parse(auditLines.at(-1) ?? '{}') as Record<string, unknown>
    expect(auditRecord).toMatchObject({
      actionSnapshot: {
        kind: 'shell',
        cwd: scrubString(childRoot, { ...childConfig.redaction, maskHighEntropyStrings: true }),
        normalizedAction: 'make guarded',
      },
      effectPlanRequestActions: expect.arrayContaining(['network.connect']),
      effectPlanRequirements: expect.arrayContaining([
        expect.objectContaining({
          action: 'network.connect',
          resource: {
            kind: 'network',
            host: 'registry',
            protocol: 'container-registry',
            mode: 'mutate',
            payload: 'present',
          },
        }),
      ]),
    })
  })

  it('does not use a non-Shell nested working directory for config or approval state', async () => {
    const parentRoot = await initIsolatedRepo()
    const childRoot = path.join(parentRoot, 'linked-workspace')
    await initProject({ targetDir: childRoot })
    const childConfig = mergeConfig({
      ...(await loadConfigFile(childRoot)),
      mode: 'enforce',
      controlPlane: {
        enabled: true,
        configDir: path.join(childRoot, '.belay-cp'),
        integrity: 'hash-pinned',
      },
      audit: { logPath: '.cursor/belay/audit.ndjson', includeAssessment: true },
    })
    await writeFile(
      path.join(childRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(childConfig, null, 2)}\n`,
    )

    const result = await runRunner(
      parentRoot,
      'belay-tool-gate',
      {
        tool_name: 'Write',
        tool_input: {
          path: '../outside.txt',
          content: 'blocked',
          working_directory: childRoot,
        },
        cwd: parentRoot,
        workspace_roots: [parentRoot, childRoot],
      },
      ['preToolUse'],
      parentRoot,
    )

    expect(JSON.parse(result.stdout)).toMatchObject({ permission: 'deny' })
    const parentConfig = await loadConfigFile(parentRoot)
    const parentPending = await loadApprovalState(
      parentRoot,
      'pending-approvals.json',
      parentConfig,
    )
    expect(parentPending.approvals).toHaveLength(1)
    expect(parentPending.approvals[0]).toMatchObject({
      kind: 'tool',
      repoRoot: parentRoot,
      cwd: parentRoot,
    })
    const childPending = await loadApprovalState(childRoot, 'pending-approvals.json', childConfig)
    expect(childPending.approvals).toHaveLength(0)
  })

  it('replays the exact denied shell action from an approval-only prompt', async () => {
    process.env.BELAY_TEST_APPROVAL_REPLAY = '1'
    const repoRoot = await initIsolatedRepo()
    const markerPath = path.join(os.tmpdir(), `${path.basename(repoRoot)}-replayed.txt`)
    tempFiles.push(markerPath)
    const command = `printf replayed > ${JSON.stringify(markerPath)}`

    const denied = await runRunner(repoRoot, 'belay-shell-gate', {
      command,
      cwd: repoRoot,
    })
    expect(JSON.parse(denied.stdout).permission).toBe('deny')

    const config = await loadConfigFile(repoRoot)
    const pending = await readJson(pendingApprovalsPath(repoRoot, config))
    expect(pending.approvals).toHaveLength(1)
    const approvalId = pending.approvals[0].approvalId

    const approvedPrompt = await runRunner(repoRoot, 'belay-before-submit', {
      prompt: `/belay-approve ${approvalId}`,
      cwd: repoRoot,
    })
    const approvedPromptJson = JSON.parse(approvedPrompt.stdout)
    expect(approvedPromptJson.continue).toBe(true)
    expect(approvedPromptJson.user_message).toContain('replay succeeded')
    expect(await readFile(markerPath, 'utf8')).toBe('replayed')

    const approved = await readJson(approvedApprovalsPath(repoRoot, config))
    expect(approved.approvals).toHaveLength(0)
  })

  it('writes rendered runtime provenance into gate audit events', async () => {
    const repoRoot = await initIsolatedRepo()

    const result = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git status',
      cwd: repoRoot,
    })

    expect(JSON.parse(result.stdout)).toEqual({ permission: 'allow' })
    const lines = (await readFile(await auditLogPath(repoRoot), 'utf8')).trim().split('\n')
    const record = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>

    expect(record).toMatchObject({
      runtimeVersion: PACKAGE_VERSION,
      runtimeBuildStamp: expect.stringMatching(
        new RegExp(`^${PACKAGE_VERSION.replace(/\./g, '\\.')}@`),
      ),
      configFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(record.runtimeBuildStamp).not.toBe(`${PACKAGE_VERSION}@source`)
  })

  it('resumes the host turn after an approval-only prompt', {
    timeout: HOST_RUNTIME_PROCESS_TEST_TIMEOUT_MS,
  }, async () => {
    const repoRoot = await initIsolatedRepo()

    const denied = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git push origin main',
      cwd: repoRoot,
    })
    const deniedJson = JSON.parse(denied.stdout)
    expect(deniedJson.permission).toBe('deny')
    expect(deniedJson.user_message).toContain('Approval ID: ')

    const config = await loadConfigFile(repoRoot)
    const pending = await readJson(pendingApprovalsPath(repoRoot, config))
    expect(pending.approvals).toHaveLength(1)
    const approvalId = pending.approvals[0].approvalId

    const approvedPrompt = await runRunner(repoRoot, 'belay-before-submit', {
      prompt: `/belay-approve ${approvalId}`,
      cwd: repoRoot,
    })
    const approvedPromptJson = JSON.parse(approvedPrompt.stdout)
    expect(approvedPromptJson.continue).toBe(true)
    expect(approvedPromptJson.user_message).toContain(approvalId)

    const allowed = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git push origin main',
      cwd: repoRoot,
    })
    expect(JSON.parse(allowed.stdout)).toEqual({ permission: 'allow' })

    const allowedAgain = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git push origin main',
      cwd: repoRoot,
    })
    expect(JSON.parse(allowedAgain.stdout)).toEqual({ permission: 'allow' })

    const approvedPath = approvedApprovalsPath(repoRoot, config)
    const approved = await readJson(approvedPath)
    await writeFile(
      approvedPath,
      `${JSON.stringify(
        {
          ...approved,
          approvals: approved.approvals.map((entry: { executionLeaseExpiresAt?: string }) => ({
            ...entry,
            executionLeaseExpiresAt: '2026-01-01T00:00:00.000Z',
          })),
        },
        null,
        2,
      )}\n`,
    )

    const deniedAgain = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git push origin main',
      cwd: repoRoot,
    })
    expect(JSON.parse(deniedAgain.stdout).permission).toBe('deny')
  })

  it('allows payload-free network reads and flags local mutations', async () => {
    const repoRoot = await initIsolatedRepo()

    const networkRead = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'curl https://example.com',
      cwd: repoRoot,
    })
    expect(JSON.parse(networkRead.stdout).permission).toBe('allow')

    const flagged = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'touch notes.txt',
      cwd: repoRoot,
    })
    expect(JSON.parse(flagged.stdout)).toEqual({ permission: 'allow' })

    const auditRaw = await readFile(await auditLogPath(repoRoot), 'utf8')
    expect(auditRaw).toContain('"verdict":"allow"')
    expect(auditRaw).toContain('"verdict":"allow_flagged"')
  })

  it('requires approval for relative repo-external shell mutations under default L3', async () => {
    const repoRoot = await initIsolatedRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# test\n')

    const deniedRedirect = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'echo hi > ../outside.txt',
      cwd: repoRoot,
    })
    expect(JSON.parse(deniedRedirect.stdout).permission).toBe('deny')

    const predicted = await classifyShellGated(
      'cp README.md ../copy.txt',
      repoRoot,
      repoRoot,
      await loadConfigFile(repoRoot),
    )
    expect(predicted.verdict).toBe('deny_pending_approval')
    expect(predicted.reason).toBe('outside_repo_mutation')
  })

  it('denies chained shell commands when a later segment is external', async () => {
    const repoRoot = await initIsolatedRepo()

    const denied = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git status && git push origin main',
      cwd: repoRoot,
    })
    expect(JSON.parse(denied.stdout).permission).toBe('deny')
  })

  it('denies shell interpreter pipes', async () => {
    const repoRoot = await initIsolatedRepo()

    const denied = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'echo hi | bash',
      cwd: repoRoot,
    })
    expect(JSON.parse(denied.stdout).permission).toBe('deny')
  })

  it('allows subagent payloads through but fingerprints payload changes separately', async () => {
    const repoRoot = await initIsolatedRepo()

    const first = await runRunner(
      repoRoot,
      'belay-tool-gate',
      {
        tool_name: 'Task',
        tool_input: {
          description: 'deploy to production after tests pass',
        },
        cwd: repoRoot,
      },
      ['preToolUse'],
    )
    expect(JSON.parse(first.stdout).permission).toBe('allow')

    const second = await runRunner(
      repoRoot,
      'belay-tool-gate',
      {
        tool_name: 'Task',
        tool_input: {
          description: 'deploy to production after smoke tests pass',
        },
        cwd: repoRoot,
      },
      ['preToolUse'],
    )
    expect(JSON.parse(second.stdout).permission).toBe('allow')

    const config = await loadConfigFile(repoRoot)
    const pending = await loadApprovalState(repoRoot, 'pending-approvals.json', config)
    expect(pending.approvals).toHaveLength(0)

    const auditRaw = await readFile(await auditLogPath(repoRoot), 'utf8')
    expect(auditRaw).toContain('subagent_external_intent_hint')
  })

  it('R40 TE: subagent deploy phrase allows but inner shell mutations are gated', async () => {
    const repoRoot = await initIsolatedRepo()

    const subagent = await runRunner(
      repoRoot,
      'belay-tool-gate',
      {
        tool_name: 'Task',
        tool_input: {
          description: 'deploy to production after tests pass',
        },
        cwd: repoRoot,
      },
      ['preToolUse'],
    )
    expect(JSON.parse(subagent.stdout).permission).toBe('allow')

    const shell = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git push origin main',
      cwd: repoRoot,
    })
    expect(JSON.parse(shell.stdout).permission).toBe('deny')

    const config = await loadConfigFile(repoRoot)
    const pending = await loadApprovalState(repoRoot, 'pending-approvals.json', config)
    expect(pending.approvals).toHaveLength(1)
    expect(pending.approvals[0].kind).toBe('shell')
    expect(pending.approvals[0].input).toBe('git push origin main')
    expect(pending.approvals[0].inputKind).toBe('shell')
  })

  it('redacts sensitive shell commands in gate audit records', async () => {
    const repoRoot = await initIsolatedRepo()

    await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'curl -H "Authorization: Bearer supersecret.token.value" https://api.example.com',
      cwd: repoRoot,
    })

    const auditRaw = await readFile(await auditLogPath(repoRoot), 'utf8')
    expect(auditRaw).not.toContain('supersecret.token.value')
    expect(auditRaw).toContain('Authorization: <redacted>')
  })

  it('allows denied shell actions in audit mode and records wouldBlock without pending approvals', async () => {
    const repoRoot = await initIsolatedRepo()
    const base = await loadConfigFile(repoRoot)
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(
        mergeConfig({
          ...base,
          mode: 'audit',
          policy: { ...base.policy, unknownLocalEffect: 'deny' },
        }),
        null,
        2,
      )}\n`,
    )

    const denied = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git push origin main',
      cwd: repoRoot,
    })
    expect(JSON.parse(denied.stdout)).toEqual({ permission: 'allow' })

    const config = await loadConfigFile(repoRoot)
    const pending = await loadApprovalState(repoRoot, 'pending-approvals.json', config)
    expect(pending.approvals).toHaveLength(0)

    const auditRaw = await readFile(await auditLogPath(repoRoot), 'utf8')
    expect(auditRaw).toContain('"wouldBlock":true')
    expect(auditRaw).toContain('"mode":"audit"')
  })

  it('stores approvals in the control plane when enabled (T3)', async () => {
    const repoRoot = await createTempRepo()
    const controlPlaneDir = path.join(repoRoot, 'user-config', 'agent-belay')
    await initProject({ targetDir: repoRoot })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(
        mergeConfig({
          ...(await loadConfigFile(repoRoot)),
          mode: 'enforce',
          controlPlane: { enabled: true, configDir: controlPlaneDir, integrity: 'hash-pinned' },
        }),
        null,
        2,
      )}\n`,
    )

    const denied = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git push origin main',
      cwd: repoRoot,
    })
    expect(JSON.parse(denied.stdout).permission).toBe('deny')

    const pending = await readJson(path.join(controlPlaneDir, 'pending-approvals.json'))
    expect(pending.approvals).toHaveLength(1)
    expect(
      await readFile(
        path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'),
        'utf8',
      ).catch(() => '[]'),
    ).not.toContain(pending.approvals[0].approvalId)
  })

  it('keeps shell gate outcomes unchanged when judge session transport is enabled', async () => {
    const repoRoot = await initIsolatedRepo()
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(
        mergeConfig({
          ...(await loadConfigFile(repoRoot)),
          mode: 'enforce',
          judge: {
            ...(await loadConfigFile(repoRoot)).judge,
            runtime: {
              session: { enabled: true, providerAllowlist: ['cursor'] },
              shadow: { enabled: false },
            },
          },
        }),
        null,
        2,
      )}\n`,
    )

    const denied = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'git push origin main',
      cwd: repoRoot,
    })
    expect(JSON.parse(denied.stdout).permission).toBe('deny')

    const allowed = await runRunner(repoRoot, 'belay-shell-gate', {
      command: 'echo hello',
      cwd: repoRoot,
    })
    expect(JSON.parse(allowed.stdout).permission).toBe('allow')
  })
})
