import { createHash } from 'node:crypto'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  buildAuditActionSnapshot,
  buildAuditReplayContext,
  hashReplayPayload,
  parseAuditActionSnapshot,
} from '../core/audit-replay-context.js'
import { serializeAuditRecordV3 } from '../core/audit-serialize.js'
import { DEFAULT_REDACTION_V3 } from '../core/config.js'

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

  it.each([
    {
      name: 'compound shell command flags',
      markers: ['task ten bash lc source', 'task ten sh xc source'],
      command: "bash -lc 'printf task ten bash lc source'; sh -xc 'printf task ten sh xc source'",
    },
    {
      name: 'compound and repeated Perl/Ruby expressions',
      markers: [
        'task ten perl compound source',
        'task ten perl repeated source',
        'task ten ruby compound source',
        'task ten ruby repeated source',
      ],
      command:
        "perl -we 'print task ten perl compound source' -e 'print task ten perl repeated source'; ruby -we 'puts task ten ruby compound source' -e 'puts task ten ruby repeated source'",
    },
    {
      name: 'attached and repeated Python/Node expressions',
      markers: [
        'task ten python attached source',
        'task ten node attached source',
        'task ten node repeated source',
      ],
      command:
        'python3 -c"print(\'task ten python attached source\')"; node --eval="console.log(\'task ten node attached source\')" -e "console.log(\'task ten node repeated source\')"',
    },
    {
      name: 'Fish init commands and repeated AppleScript expressions',
      markers: [
        'task ten fish init source',
        'task ten fish command source',
        'task ten applescript first source',
        'task ten applescript repeated source',
      ],
      command:
        "fish -C 'echo task ten fish init source' -c 'echo task ten fish command source'; osascript -e 'return task ten applescript first source' -e 'return task ten applescript repeated source'",
    },
    {
      name: 'executable here strings',
      markers: ['task ten python here string source', 'task ten bash here string source'],
      command:
        "python3 <<< \"print('task ten python here string source')\"; bash 3<<< 'echo task ten bash here string source'",
    },
  ])('removes every $name fragment from all new shell audit projections', ({
    command,
    markers,
  }) => {
    const result = { normalizedCommand: command, summary: command }
    const replayAction = { kind: 'shell', cwd, command }
    const snapshot = buildAuditActionSnapshot('shell', result, replayAction)
    const replayContext = buildAuditReplayContext('shell', result, replayAction)
    const serialized = serializeAuditRecordV3(
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        summary: command,
        actionSnapshot: snapshot,
        replayContext,
      },
      DEFAULT_REDACTION_V3,
    )
    const retained = JSON.stringify({ snapshot, replayContext, serialized })

    for (const marker of markers) {
      expect(retained).not.toContain(marker)
    }
    expect(snapshot).toMatchObject({ schemaVersion: 2, kind: 'shell', cwd })
    expect(replayContext).toMatchObject({ kind: 'shell', cwd })
  })

  it('preserves non-source interpreter file arguments in compact shell projections', () => {
    const safeMarker = 'task ten safe interpreter argument'
    const command = `python3 scripts/check.py --label '${safeMarker}'`
    const result = { normalizedCommand: command, summary: command }
    const replayAction = { kind: 'shell', cwd, command }
    const retained = JSON.stringify({
      snapshot: buildAuditActionSnapshot('shell', result, replayAction),
      replayContext: buildAuditReplayContext('shell', result, replayAction),
    })

    expect(retained).toContain('scripts/check.py')
    expect(retained).toContain(safeMarker)
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

  it('projects an unknown path-only tool as a mutation like the live classifier fallback', () => {
    const payload = { path: 'notes.txt' }

    const snapshot = buildAuditActionSnapshot(
      'tool',
      { summary: 'CustomPathTool notes.txt' },
      { kind: 'tool', cwd, toolName: 'CustomPathTool', payload },
    )

    expect(snapshot).toEqual({
      schemaVersion: 2,
      kind: 'tool',
      cwd,
      toolName: 'CustomPathTool',
      operation: 'write',
      path: 'notes.txt',
      payloadHash: hashReplayPayload(payload),
    })
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
