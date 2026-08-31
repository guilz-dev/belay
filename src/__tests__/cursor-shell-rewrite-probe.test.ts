import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

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
    'keeps timeout evidence and kills a ready descendant after the direct child exits',
    async () => {
      const { runCommandCapture, terminateProbeProcessGroup } = await probeModule()
      const directory = await createTempDir()
      const stdoutPath = path.join(directory, 'stdout.ndjson')
      const stderrPath = path.join(directory, 'stderr.log')
      const processRecordPath = path.join(directory, 'process-record.json')
      const grandchildTermAckPath = path.join(directory, 'grandchild.term')
      const grandchildProgram = [
        "const { writeFileSync } = require('node:fs')",
        'const [termAckPath] = process.argv.slice(1)',
        "process.on('SIGTERM', () => { writeFileSync(termAckPath, 'term') })",
        "process.stdout.write('ready\\n')",
        'setInterval(() => {}, 1000)',
      ].join('; ')
      const childProgram = [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildProgram)}, ${JSON.stringify(grandchildTermAckPath)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
        `grandchild.stdout.once('data', () => { const record = JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }); writeFileSync(${JSON.stringify(processRecordPath)}, record); process.stdout.write(record + '\\n'); process.stdout.write('early stdout\\n'); process.stderr.write('early stderr\\n') })`,
        'setInterval(() => {}, 1000)',
      ].join('; ')
      let childPid: number | null = null
      let grandchildPid: number | null = null

      try {
        const startedAt = performance.now()
        const result = await runCommandCapture(process.execPath, ['-e', childProgram], {
          stdoutPath,
          stderrPath,
          timeoutMs: 4_000,
        })
        const settledAfterMs = performance.now() - startedAt
        const processRecord = await readFile(processRecordPath, 'utf8')
        ;({ childPid, grandchildPid } = JSON.parse(processRecord))
        if (typeof childPid !== 'number' || typeof grandchildPid !== 'number') {
          throw new Error('ready process record must contain numeric child and grandchild PIDs')
        }

        expect(result.timedOut).toBe(true)
        expect(result.signal).toBe('SIGTERM')
        expect(await readFile(grandchildTermAckPath, 'utf8')).toBe('term')
        await expect(readFile(stdoutPath, 'utf8')).resolves.toBe(`${processRecord}\nearly stdout\n`)
        await expect(readFile(stderrPath, 'utf8')).resolves.toBe('early stderr\n')
        expect(settledAfterMs).toBeGreaterThanOrEqual(4_900)
      } finally {
        if (childPid === null || grandchildPid === null) {
          try {
            ;({ childPid, grandchildPid } = JSON.parse(await readFile(processRecordPath, 'utf8')))
          } catch {
            // The timeout path may have ended before the fixture created a descendant.
          }
        }
        if (childPid !== null) {
          terminateProbeProcessGroup({ pid: childPid, kill: () => false }, 'SIGKILL')
        }
        if (grandchildPid !== null) {
          try {
            process.kill(grandchildPid, 'SIGKILL')
          } catch {
            // The expected path already killed the descendant.
          }
        }
      }
    },
    10_000,
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
