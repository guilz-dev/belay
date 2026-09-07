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

  it('never embeds command, pattern, prompt, or raw tool ids in compact summaries', () => {
    const rawToolUseId = 'tool_abc'
    const commandProjection = projectObservedAudit(
      {
        tool_name: 'Shell',
        tool_input: { command: `printf secret-${rawToolUseId}` },
        tool_use_id: rawToolUseId,
      },
      'postToolUse',
      '/repo',
      DEFAULT_REDACTION_V3,
    )
    const patternProjection = projectObservedAudit(
      {
        tool_name: 'Search',
        tool_input: { pattern: `customer-secret-${rawToolUseId}` },
        tool_use_id: rawToolUseId,
      },
      'postToolUse',
      '/repo',
      DEFAULT_REDACTION_V3,
    )
    const genericSummary = compactToolGateSummary(
      'CustomPromptTool',
      { prompt: 'short private prompt' },
      '',
      DEFAULT_REDACTION_V3,
    )
    const gateSummary = compactToolGateSummary(
      'CustomShellTool',
      { command: `printf secret-${rawToolUseId}` },
      '',
      DEFAULT_REDACTION_V3,
      rawToolUseId,
    )

    expect(commandProjection.summary).not.toContain('printf secret')
    expect(commandProjection.summary).not.toContain(rawToolUseId)
    expect(patternProjection.summary).not.toContain('customer-secret')
    expect(patternProjection.summary).not.toContain(rawToolUseId)
    expect(genericSummary).not.toContain('short private prompt')
    expect(gateSummary).not.toContain(rawToolUseId)
  })

  it('stores cwd relative to the repository, including root and outside paths', () => {
    const atRoot = projectObservedAudit(
      { tool_name: 'Read', cwd: '/repo', tool_input: { file_path: 'src/foo.ts' } },
      'postToolUse',
      '/repo',
      DEFAULT_REDACTION_V3,
    )
    const outside = projectObservedAudit(
      { tool_name: 'Read', cwd: '/other', tool_input: { file_path: 'src/foo.ts' } },
      'postToolUse',
      '/repo',
      DEFAULT_REDACTION_V3,
    )

    expect(atRoot.observedCwd).toBe('.')
    expect(outside.observedCwd).toBe('../other')
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
