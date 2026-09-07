import { describe, expect, it } from 'vitest'

import { buildAuditActionSnapshot } from '../core/audit-replay-context.js'

describe('audit action snapshot v2', () => {
  it.each([
    'Write',
    'Edit',
    'StrReplace',
    'MultiEdit',
    'NotebookEdit',
  ])('keeps path-only %s adapter payloads as file mutations', (toolName) => {
    const snapshot = buildAuditActionSnapshot(
      'tool',
      { summary: `${toolName} notes.txt` },
      {
        kind: 'tool',
        cwd: '/repo',
        toolName,
        payload: { path: 'notes.txt' },
      },
    )

    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      action: { type: 'file', operation: 'write', path: 'notes.txt' },
    })
  })

  it('keeps patch targets including move destinations without patch bodies', () => {
    const snapshot = buildAuditActionSnapshot(
      'tool',
      { summary: 'patch files' },
      {
        kind: 'tool',
        cwd: '/repo',
        toolName: 'ApplyPatch',
        payload: {
          patch: [
            '*** Begin Patch',
            '*** Update File: src/old.ts',
            '*** Move to: src/new.ts',
            '@@',
            '-private source body',
            '+replacement source body',
            '*** End Patch',
          ].join('\n'),
        },
      },
    )

    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      kind: 'tool',
      toolName: 'ApplyPatch',
      action: {
        type: 'patch',
        targets: [
          { operation: 'update', path: 'src/old.ts' },
          { operation: 'update', path: 'src/new.ts' },
        ],
      },
    })
    expect(JSON.stringify(snapshot)).not.toContain('private source body')
    expect(JSON.stringify(snapshot)).not.toContain('replacement source body')
  })

  it('stores subagent classifier evidence without prompt text', () => {
    const snapshot = buildAuditActionSnapshot(
      'subagent',
      { summary: 'delegate' },
      {
        kind: 'subagent',
        cwd: '/repo',
        toolName: 'Task',
        payload: {
          description: 'release helper',
          prompt: 'publish the private package contents',
        },
      },
    )

    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      kind: 'subagent',
      action: {
        type: 'subagent',
        subagentType: 'Task',
        externalIntent: true,
        summaryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(JSON.stringify(snapshot)).not.toContain('private package')
  })
})
