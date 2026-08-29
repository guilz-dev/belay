import { describe, expect, it } from 'vitest'

describe('Cursor Shell rewrite probe transcript parser', () => {
  it('extracts completed Shell output from fixed stream-json events', async () => {
    const parserModuleUrl = new URL('../../scripts/cursor-shell-rewrite-probe.mjs', import.meta.url)
    const { parseStreamJsonTranscript } = await import(parserModuleUrl.href)
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
      eventCount: 3,
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
})
