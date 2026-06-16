import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_V4, scrubOptionsFromConfig } from '../core/config.js'
import { toolFingerprint } from '../core/fingerprint.js'
import { fingerprintReplayPayload } from '../core/replay-scrub.js'

describe('replay-scrub', () => {
  it('scrubs tool_input for tool replay payload', () => {
    const scrubOpts = scrubOptionsFromConfig(DEFAULT_CONFIG_V4)
    const payload = {
      tool_name: 'Write',
      tool_input: { path: 'notes.txt', contents: 'hello' },
    }
    const replayPayload = fingerprintReplayPayload('tool', payload, scrubOpts)
    expect(replayPayload).toEqual({ path: 'notes.txt', contents: 'hello' })
    expect(toolFingerprint('Write', replayPayload ?? {}, '/repo')).toBe(
      toolFingerprint('Write', replayPayload ?? {}, '/repo'),
    )
  })

  it('scrubs subagent description/prompt subset for replay payload', () => {
    const scrubOpts = scrubOptionsFromConfig(DEFAULT_CONFIG_V4)
    const payload = {
      tool_name: 'Task',
      tool_input: { description: 'deploy to prod', prompt: 'ship it' },
    }
    const replayPayload = fingerprintReplayPayload('subagent', payload, scrubOpts)
    expect(replayPayload).toEqual({ description: 'deploy to prod', prompt: 'ship it' })
  })
})
