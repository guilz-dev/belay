import { existsSync } from 'node:fs'
import path from 'node:path'

import { getManagedHookEvents, type ManagedHookDefinition } from './defaults.js'
import { loadHooksFile } from './installer.js'
import { resolveNodeBinary } from './node-resolution.js'
import type { DoctorOptions, DoctorReport } from './types.js'

export async function doctorProject(options: DoctorOptions = {}): Promise<DoctorReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const cursorDir = path.join(repoRoot, '.cursor')
  const configPath = path.join(cursorDir, 'belay.config.json')
  const hooksPath = path.join(cursorDir, 'hooks.json')
  const issues: string[] = []
  const notes: string[] = []

  if (!existsSync(configPath)) {
    issues.push(`Missing config: ${configPath}`)
  }

  const requiredPaths = [
    path.join(cursorDir, 'hooks', 'belay-runner'),
    path.join(cursorDir, 'hooks', 'belay-runner.cmd'),
    path.join(cursorDir, 'hooks', 'belay-before-submit.mjs'),
    path.join(cursorDir, 'hooks', 'belay-shell-gate.mjs'),
    path.join(cursorDir, 'hooks', 'belay-tool-gate.mjs'),
    path.join(cursorDir, 'hooks', 'belay-audit.mjs'),
    path.join(cursorDir, 'belay', 'runtime', 'core.mjs'),
    path.join(cursorDir, 'belay', 'pending-approvals.json'),
    path.join(cursorDir, 'belay', 'approved-approvals.json'),
    path.join(cursorDir, 'belay', 'audit.ndjson'),
  ]
  for (const requiredPath of requiredPaths) {
    if (!existsSync(requiredPath)) {
      issues.push(`Missing generated file: ${requiredPath}`)
    }
  }

  let hooksOk = true
  try {
    const hooksFile = await loadHooksFile(hooksPath)
    const managedEntries = Object.entries(getManagedHookEvents(process.platform)) as Array<
      [string, ManagedHookDefinition]
    >
    for (const [eventName, definition] of managedEntries) {
      const entries = hooksFile.hooks[eventName] ?? []
      const present = entries.some(
        (entry) => entry.command === definition.command && entry.matcher === definition.matcher,
      )
      if (!present) {
        hooksOk = false
        issues.push(`Missing managed hook for ${eventName}: ${definition.command}`)
      }
    }
  } catch (error) {
    hooksOk = false
    issues.push(error instanceof Error ? error.message : 'Failed to parse hooks.json')
  }

  const nodeResolution = resolveNodeBinary()
  if (!nodeResolution.ok) {
    issues.push(nodeResolution.detail)
  } else {
    notes.push(`Node resolved at ${nodeResolution.path}`)
  }

  const report: DoctorReport = {
    ok: issues.length === 0 && hooksOk,
    repoRoot,
    configPath,
    hooksPath,
    nodeResolution,
    issues,
    notes,
  }
  return report
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `agent-belay doctor for ${report.repoRoot}`,
    `Config: ${report.configPath}`,
    `Hooks: ${report.hooksPath}`,
    `Node: ${report.nodeResolution.ok ? report.nodeResolution.path : 'unresolved'}`,
  ]

  if (report.notes.length > 0) {
    lines.push('', 'Notes:')
    for (const note of report.notes) {
      lines.push(`- ${note}`)
    }
  }

  if (report.issues.length > 0) {
    lines.push('', 'Issues:')
    for (const issue of report.issues) {
      lines.push(`- ${issue}`)
    }
  } else {
    lines.push('', 'No issues detected.')
  }

  return `${lines.join('\n')}\n`
}
