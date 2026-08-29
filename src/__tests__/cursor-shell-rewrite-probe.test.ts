import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []
const parserModuleUrl = new URL('../../scripts/cursor-shell-rewrite-probe.mjs', import.meta.url)

async function probeModule() {
  return await import(parserModuleUrl.href)
}

async function createTempDir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-shell-rewrite-probe-test-'))
  tempDirs.push(directory)
  return directory
}

function isProcessRunning(pid: number) {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  return result.status === 0 && !result.stdout.trim().startsWith('Z')
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Cursor Shell rewrite probe transcript parser', () => {
  it('extracts completed Shell output from fixed stream-json events', async () => {
    const { parseStreamJsonTranscript } = await probeModule()
    const transcript = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        apiKeySource: 'login',
        cwd: '/private/temporary-probe',
        session_id: 'session-123',
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        tool_call: {
          shellToolCall: {
            args: { command: 'node -e "console.log(\'CURSOR_REWRITE_STDOUT_nonce\')"' },
          },
        },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          shellToolCall: {
            args: { command: 'node -e "console.log(\'CURSOR_REWRITE_STDOUT_nonce\')"' },
            result: {
              success: {
                stdout: 'CURSOR_REWRITE_STDOUT_nonce\n',
                stderr: 'CURSOR_REWRITE_STDERR_nonce\n',
                exitCode: 37,
              },
            },
          },
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
      'truncated non-json event',
    ].join('\n')

    expect(parseStreamJsonTranscript(transcript)).toEqual({
      eventCount: 4,
      malformedLineCount: 1,
      terminalResult: { subtype: 'success', isError: false },
      shellCalls: [
        {
          command: 'node -e "console.log(\'CURSOR_REWRITE_STDOUT_nonce\')"',
          stdout: 'CURSOR_REWRITE_STDOUT_nonce\n',
          stderr: 'CURSOR_REWRITE_STDERR_nonce\n',
          exitCode: 37,
        },
      ],
    })
  })

  it('emits valid deny JSON for non-nonce commands in malformed and nonzero modes', async () => {
    const { createProbeHookProgram } = await probeModule()
    const directory = await createTempDir()
    const hookPath = path.join(directory, 'probe-hook.mjs')
    const eventLog = path.join(directory, 'hook-events.ndjson')
    const original = 'node -e "console.log(\'original-nonce\')"'
    const mediated = 'node -e "console.log(\'mediated-nonce\')"'
    await writeFile(hookPath, createProbeHookProgram())

    for (const mode of ['malformed', 'nonzero']) {
      const result = spawnSync(
        process.execPath,
        [
          hookPath,
          'preToolUse',
          mode,
          'nonce',
          Buffer.from(original).toString('base64url'),
          Buffer.from(mediated).toString('base64url'),
          eventLog,
        ],
        { input: JSON.stringify({ command: 'echo non-nonce-retry' }), encoding: 'utf8' },
      )

      expect(result.status, mode).toBe(0)
      expect(JSON.parse(result.stdout), mode).toMatchObject({ permission: 'deny' })
    }
  })

  it('captures child output as it arrives and records a case timeout', async () => {
    const { runCommandCapture } = await probeModule()
    const directory = await createTempDir()
    const stdoutPath = path.join(directory, 'stdout.ndjson')
    const stderrPath = path.join(directory, 'stderr.log')
    const result = await runCommandCapture(
      process.execPath,
      [
        '-e',
        "process.stdout.write('early stdout\\n'); process.stderr.write('early stderr\\n'); setTimeout(() => {}, 1000)",
      ],
      { stdoutPath, stderrPath, timeoutMs: 50 },
    )

    expect(result.timedOut).toBe(true)
    await expect(readFile(stdoutPath, 'utf8')).resolves.toBe('early stdout\n')
    await expect(readFile(stderrPath, 'utf8')).resolves.toBe('early stderr\n')
  })

  const processGroupIt = process.platform === 'win32' ? it.skip : it
  processGroupIt('terminates a timed-out child process group', async () => {
    const { runCommandCapture } = await probeModule()
    const directory = await createTempDir()
    const grandchildPidPath = path.join(directory, 'grandchild.pid')
    const childProgram = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid))`,
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)',
    ].join('; ')

    const result = await runCommandCapture(process.execPath, ['-e', childProgram], {
      timeoutMs: 100,
    })
    const grandchildPid = Number(await readFile(grandchildPidPath, 'utf8'))

    try {
      expect(result.timedOut).toBe(true)
      expect(isProcessRunning(grandchildPid)).toBe(false)
    } finally {
      if (isProcessRunning(grandchildPid)) process.kill(grandchildPid, 'SIGKILL')
    }
  })

  processGroupIt('keeps the group SIGKILL fallback after the direct child exits', async () => {
    const { runCommandCapture } = await probeModule()
    const directory = await createTempDir()
    const grandchildPidPath = path.join(directory, 'detached-grandchild.pid')
    const childProgram = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid))`,
      'setInterval(() => {}, 1000)',
    ].join('; ')

    const result = await runCommandCapture(process.execPath, ['-e', childProgram], {
      timeoutMs: 100,
    })
    const grandchildPid = Number(await readFile(grandchildPidPath, 'utf8'))

    try {
      expect(result.timedOut).toBe(true)
      expect(isProcessRunning(grandchildPid)).toBe(false)
    } finally {
      if (isProcessRunning(grandchildPid)) process.kill(grandchildPid, 'SIGKILL')
    }
  })

  it('accepts only explicit authenticated JSON status', async () => {
    const { isExplicitlyAuthenticated } = await probeModule()

    expect(
      isExplicitlyAuthenticated({
        code: 0,
        stdout: '{"isAuthenticated":true,"status":"authenticated"}',
      }),
    ).toBe(true)
    expect(isExplicitlyAuthenticated({ code: 0, stdout: '{"isAuthenticated":true}' })).toBe(false)
    expect(isExplicitlyAuthenticated({ code: 0, stdout: '{"status":"authenticated"}' })).toBe(false)
    expect(isExplicitlyAuthenticated({ code: 0, stdout: 'not JSON' })).toBe(false)
    expect(
      isExplicitlyAuthenticated({
        code: 1,
        stdout: '{"isAuthenticated":true,"status":"authenticated"}',
      }),
    ).toBe(false)
    expect(
      isExplicitlyAuthenticated({
        code: 0,
        timedOut: true,
        stdout: '{"isAuthenticated":true,"status":"authenticated"}',
      }),
    ).toBe(false)
  })

  it('labels the digest as a raw-evidence manifest hash', async () => {
    const { renderResultSpec } = await probeModule()
    const rendered = renderResultSpec({
      cursorVersion: '2026.08.28',
      os: 'darwin test arm64',
      userHooks: { exists: false, sha256: null },
      rawEvidenceManifestHash: 'a'.repeat(64),
      cases: [
        {
          case: 'A',
          exit: { code: null, timedOut: true },
          markers: {},
          hookInvocationCount: 0,
          stream: { eventCount: 0, malformedLineCount: 0 },
        },
      ],
    })

    expect(rendered).toContain('Raw-evidence manifest SHA-256')
    expect(rendered).not.toContain('Evidence directory SHA-256')
    expect(rendered).toContain('timed out true')
  })
})
