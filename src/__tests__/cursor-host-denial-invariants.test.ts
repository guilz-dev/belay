import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  isUnsafeGlobalHookFallback,
  resolveCursorActionCwdDetails,
} from '../adapters/cursor/cwd-resolution.js'
import { cursorCliConfigPaths } from '../commands/health-snapshot.js'
import { toolInvocationCorrelationId } from '../core/audit-io.js'
import { toAuditRecord } from '../core/audit-metrics.js'
import { summarizeAuditVisibility } from '../core/audit-summary.js'

const runtimeEntryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../adapters/cursor/runtime-entry.ts',
)

describe('regression: PR #87/#88 merge conflict', () => {
  it('normalizes tool_ prefixed UUIDs to the same correlation hash as bare UUIDs', () => {
    const bareUuid = 'f5be1fa7-4c96-4568-817d-098e61fbf891'
    expect(toolInvocationCorrelationId(`tool_${bareUuid}`)).toBe(
      toolInvocationCorrelationId(bareUuid),
    )
  })

  it('returns unrecognizedHostFailureCount from summarizeAuditVisibility', () => {
    const records = [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        event: 'postToolUseFailure',
        kind: 'audit',
        verdict: 'allow',
        reason: 'observed',
        failureType: 'timeout',
      },
    ].map((entry) => toAuditRecord(entry))

    expect(summarizeAuditVisibility(records).unrecognizedHostFailureCount).toBe(1)
  })

  it('falls back to ~/.cursor when XDG cursor config is missing', () => {
    const homeDir = '/tmp/belay-home'
    const xdgRoot = '/tmp/empty-xdg'
    const paths = cursorCliConfigPaths(homeDir, { XDG_CONFIG_HOME: xdgRoot })

    expect(paths).toEqual([
      path.join(xdgRoot, 'cursor', 'cli-config.json'),
      path.join(homeDir, '.cursor', 'cli-config.json'),
    ])
  })

  it('keeps global hook fail-close when payload workspace is missing', () => {
    const resolution = resolveCursorActionCwdDetails({}, 'fallback-action')
    expect(isUnsafeGlobalHookFallback(resolution, true)).toBe(true)
  })

  it('keeps payload-first workspace cwd resolution', () => {
    const resolution = resolveCursorActionCwdDetails({ cwd: '/workspace/repo' }, 'fallback')
    expect(resolution.cwd).toBe(path.resolve('/workspace/repo'))
    expect(resolution.fromPayload).toBe(true)
  })

  it('passes payload through runShellGateHook for beforeShellExecution correlation', async () => {
    const source = await readFile(runtimeEntryPath, 'utf8')
    const shellGateBlock = source.slice(
      source.indexOf('export async function runShellGateHook'),
      source.indexOf('export async function runToolGateHook'),
    )
    expect(shellGateBlock).toMatch(
      /evaluateGatedAction\([\s\S]*payload,[\s\S]*beforeShellExecution/,
    )
  })
})
