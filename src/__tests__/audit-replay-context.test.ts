import { createHash } from 'node:crypto'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  buildAuditActionSnapshot,
  buildAuditReplayContext,
  hashReplayPayload,
  parseAuditActionSnapshot,
} from '../core/audit-replay-context.js'

describe('compact audit action snapshots', () => {
  const cwd = '/workspace/project'

  it('writes a v2 shell projection without executable heredoc source bodies', () => {
    const sourceMarker = 'task ten executable source canary'
    const command = `python3 - <<'PY'\nprint('${sourceMarker}')\nPY`

    const snapshot = buildAuditActionSnapshot(
      'shell',
      { normalizedCommand: command, summary: command },
      { kind: 'shell', cwd, command },
    )

    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      kind: 'shell',
      cwd,
    })
    expect(snapshot && 'normalizedAction' in snapshot ? snapshot.normalizedAction : '').toContain(
      "python3 - <<'PY'",
    )
    expect(JSON.stringify(snapshot)).not.toContain(sourceMarker)
  })

  it('writes a replayable v2 tool projection with only operation, normalized path, and hash', () => {
    const toolInputMarker = 'task ten tool input canary'
    const payload = {
      path: 'src/feature/../target.ts',
      contents: toolInputMarker,
    }

    const snapshot = buildAuditActionSnapshot(
      'tool',
      { summary: toolInputMarker },
      { kind: 'tool', cwd, toolName: 'Write', payload },
    )

    expect(snapshot).toEqual({
      schemaVersion: 2,
      kind: 'tool',
      cwd,
      toolName: 'Write',
      operation: 'write',
      path: path.normalize('src/target.ts'),
      payloadHash: hashReplayPayload(payload),
    })
    expect(JSON.stringify(snapshot)).not.toContain(toolInputMarker)
  })

  it('writes only a SHA-256 hash for a subagent summary and omits replay payloads', () => {
    const promptMarker = 'task ten subagent prompt canary'
    const summary = `Review this change: ${promptMarker}`
    const payload = { description: 'review', prompt: promptMarker }

    const snapshot = buildAuditActionSnapshot(
      'subagent',
      { summary },
      { kind: 'subagent', cwd, toolName: 'Task', payload },
    )
    const replay = buildAuditReplayContext(
      'subagent',
      { summary },
      { kind: 'subagent', cwd, toolName: 'Task', payload },
    )

    expect(snapshot).toEqual({
      schemaVersion: 2,
      kind: 'subagent',
      cwd,
      toolName: 'Task',
      summaryHash: createHash('sha256').update(summary).digest('hex'),
    })
    expect(replay).toEqual({ cwd, kind: 'subagent', toolName: 'Task' })
    expect(JSON.stringify({ snapshot, replay })).not.toContain(promptMarker)
  })
})

describe('audit action snapshot compatibility parsing', () => {
  it('normalizes legacy v1 and current v2 shell snapshots to replay actions', () => {
    const command = 'git status --short'
    const legacy = parseAuditActionSnapshot({
      actionSnapshot: {
        schemaVersion: 1,
        kind: 'shell',
        cwd: '/workspace/project',
        normalizedAction: command,
      },
    })
    const current = parseAuditActionSnapshot({
      actionSnapshot: {
        schemaVersion: 2,
        kind: 'shell',
        cwd: '/workspace/project',
        normalizedAction: command,
      },
    })

    expect(legacy).toMatchObject({
      replayable: true,
      sourceSchemaVersion: 1,
      kind: 'shell',
      cwd: '/workspace/project',
      command,
    })
    expect(current).toMatchObject({
      replayable: true,
      sourceSchemaVersion: 2,
      kind: 'shell',
      cwd: '/workspace/project',
      command,
    })
  })

  it('normalizes a complete v2 tool projection to a payload-free replay action', () => {
    const parsed = parseAuditActionSnapshot({
      actionSnapshot: {
        schemaVersion: 2,
        kind: 'tool',
        cwd: '/workspace/project',
        toolName: 'Write',
        operation: 'write',
        path: 'src/index.ts',
        payloadHash: 'a'.repeat(64),
      },
    })

    expect(parsed).toMatchObject({
      replayable: true,
      sourceSchemaVersion: 2,
      kind: 'tool',
      cwd: '/workspace/project',
      toolName: 'Write',
      operation: 'write',
      path: 'src/index.ts',
      payloadHash: 'a'.repeat(64),
    })
    expect(JSON.stringify(parsed)).not.toContain('contents')
  })

  it('types an incomplete v2 tool projection as non-replayable', () => {
    expect(
      parseAuditActionSnapshot({
        actionSnapshot: {
          schemaVersion: 2,
          kind: 'tool',
          cwd: '/workspace/project',
          toolName: 'Write',
          payloadHash: 'b'.repeat(64),
        },
      }),
    ).toEqual({
      replayable: false,
      sourceSchemaVersion: 2,
      kind: 'tool',
      cwd: '/workspace/project',
      reason: 'tool_projection_incomplete',
    })
  })
})
