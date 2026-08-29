import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

async function waitFor(condition: () => Promise<boolean> | boolean, description: string) {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${description}`)
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

  it('projects exactly one rejected completed Shell call from Cursor stream-json', async () => {
    const { parseStreamJsonTranscript } = await probeModule()
    const command = 'node -e "console.log(\'CURSOR_REWRITE_STDOUT_nonce\')"'
    const transcript = [
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        tool_call: { shellToolCall: { args: { command } } },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          shellToolCall: {
            result: {
              rejected: {
                command,
                reason: `sk_live_probe_token ${'r'.repeat(600)}`,
                evidence: 'agent@example.com',
              },
            },
          },
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
    ].join('\n')

    const parsed = parseStreamJsonTranscript(transcript)

    expect(parsed.shellCalls).toHaveLength(1)
    expect(parsed.shellCalls[0]).toMatchObject({
      command,
      outcome: 'rejected',
      rejection: { evidence: '<redacted-email>' },
    })
    expect(parsed.shellCalls[0].rejection.reason).toContain('<redacted-token>')
    expect(parsed.shellCalls[0].rejection.reason.length).toBeLessThanOrEqual(512)
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

  it('captures child output into evidence files as it arrives', async () => {
    const { runCommandCapture } = await probeModule()
    const directory = await createTempDir()
    const stdoutPath = path.join(directory, 'stdout.ndjson')
    const stderrPath = path.join(directory, 'stderr.log')
    const result = await runCommandCapture(
      process.execPath,
      ['-e', "process.stdout.write('early stdout\\n'); process.stderr.write('early stderr\\n')"],
      { stdoutPath, stderrPath },
    )

    expect(result.timedOut).toBe(false)
    await expect(readFile(stdoutPath, 'utf8')).resolves.toBe('early stdout\n')
    await expect(readFile(stderrPath, 'utf8')).resolves.toBe('early stderr\n')
  })

  const processGroupIt = process.platform === 'win32' ? it.skip : it
  processGroupIt(
    'terminates a ready POSIX process-group descendant with SIGTERM then SIGKILL',
    async () => {
      const { terminateProbeProcessGroup } = await probeModule()
      const directory = await createTempDir()
      const grandchildReadyPath = path.join(directory, 'grandchild.ready')
      const grandchildTermAckPath = path.join(directory, 'grandchild.term')
      const grandchildAfterKillPath = path.join(directory, 'grandchild.after-kill')
      const childProgram = [
        "const { spawn } = require('node:child_process')",
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify("const { writeFileSync } = require('node:fs'); const [readyPath, termAckPath, afterKillPath] = process.argv.slice(1); process.on('SIGTERM', () => { writeFileSync(termAckPath, 'term'); setTimeout(() => writeFileSync(afterKillPath, 'unexpected'), 100) }); writeFileSync(readyPath, 'ready'); setInterval(() => {}, 1000)")}, ${JSON.stringify(grandchildReadyPath)}, ${JSON.stringify(grandchildTermAckPath)}, ${JSON.stringify(grandchildAfterKillPath)}], { stdio: 'ignore' })`,
        'setInterval(() => {}, 1000)',
      ].join('; ')
      const child = spawn(process.execPath, ['-e', childProgram], {
        detached: true,
        stdio: 'ignore',
      })
      await waitFor(async () => {
        try {
          return (await readFile(grandchildReadyPath, 'utf8')) === 'ready'
        } catch {
          return false
        }
      }, 'grandchild SIGTERM handler readiness')

      try {
        terminateProbeProcessGroup(child, 'SIGTERM')
        await waitFor(async () => {
          try {
            return (await readFile(grandchildTermAckPath, 'utf8')) === 'term'
          } catch {
            return false
          }
        }, 'grandchild SIGTERM acknowledgement')
        terminateProbeProcessGroup(child, 'SIGKILL')
        await new Promise((resolve) => setTimeout(resolve, 150))
        await expect(access(grandchildAfterKillPath)).rejects.toThrow()
      } finally {
        terminateProbeProcessGroup(child, 'SIGKILL')
      }
    },
  )

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
