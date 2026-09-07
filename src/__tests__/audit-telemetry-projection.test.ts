import { describe, expect, it } from 'vitest'

import {
  compactSubagentGateSummary,
  compactToolGateSummary,
  projectObservedAudit,
} from '../core/audit-telemetry-projection.js'
import { DEFAULT_REDACTION_V3 } from '../core/config.js'

describe('audit-telemetry-projection', () => {
  it('compacts Write tool_input without embedding old_string/new_string bodies', () => {
    const summary = compactToolGateSummary('Write', {
      file_path: 'src/foo.ts',
      old_string: 'x'.repeat(10_000),
      new_string: 'y'.repeat(10_000),
    })
    expect(summary.length).toBeLessThan(500)
    expect(summary).toContain('src/foo.ts')
    expect(summary).not.toContain('x'.repeat(100))
  })

  it('projects observed audit without full payload in summary', () => {
    const projection = projectObservedAudit(
      {
        tool_name: 'Read',
        tool_input: { file_path: 'src/foo.ts' },
        tool_output: { content: 'hello world' },
        tool_use_id: 'tool_abc',
      },
      'postToolUse',
      '/repo',
      DEFAULT_REDACTION_V3,
    )
    expect(projection.summary).toContain('Read src/foo.ts')
    expect(projection.summary).not.toContain('hello world')
    expect(projection.observedInputBytes).toBeGreaterThan(0)
    expect(projection.observedOutputBytes).toBeGreaterThan(0)
    expect(projection.observedPayloadHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('compacts subagent prompts to byte length and hash', () => {
    const summary = compactSubagentGateSummary({
      tool_name: 'Task',
      tool_input: {
        description: 'refactor module',
        prompt: 'please refactor the auth module carefully',
      },
    })
    expect(summary).toContain('Task')
    expect(summary).toContain('prompt')
    expect(summary).not.toContain('please refactor the auth module carefully')
  })
})
