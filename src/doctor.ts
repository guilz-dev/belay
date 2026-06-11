import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { getAdapter } from './adapters/registry.js'
import { cleanupOrphanApprovalState } from './cleanup-orphans.js'
import {
  approvedApprovalsPath,
  belayStateDir,
  configPathFor,
  loadConfigFile,
  pendingApprovalsPath,
  repoLocalStateDirFor,
  runtimeCorePath,
} from './config-io.js'
import { defaultControlPlaneDir } from './core/config.js'
import { resolveNodeBinary } from './node-resolution.js'
import { loadOperationalInsights } from './operational-insights.js'
import type { AdapterName, DoctorOptions, DoctorReport } from './types.js'
import { PACKAGE_VERSION } from './version.js'

async function readRuntimeVersion(corePath: string): Promise<{ stamp?: string; version?: string }> {
  try {
    const content = await readFile(corePath, 'utf8')
    const stampMatch = content.match(/RUNTIME_BUILD_STAMP\s*=\s*"([^"]+)"/)
    const versionMatch = content.match(/RUNTIME_PACKAGE_VERSION\s*=\s*"([^"]+)"/)
    return {
      stamp: stampMatch?.[1],
      version: versionMatch?.[1],
    }
  } catch {
    return {}
  }
}

function resolveDoctorAdapter(options: DoctorOptions, configAdapter?: AdapterName): AdapterName {
  if (options.adapter) {
    return options.adapter
  }
  return configAdapter === 'claude' ? 'claude' : 'cursor'
}

export async function doctorProject(options: DoctorOptions = {}): Promise<DoctorReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const issues: string[] = []
  const notes: string[] = []
  const warnings: string[] = []

  let loadedConfig = null
  let adapterName: AdapterName = options.adapter ?? 'cursor'
  const adapter = getAdapter(adapterName)
  const layout = adapter.layout
  let configPath = layout.configPath(repoRoot)
  let hooksPath = layout.hooksSettingsPath(repoRoot)
  let corePath = runtimeCorePath(repoRoot, adapterName)

  if (
    !existsSync(configPath) &&
    adapterName === 'cursor' &&
    existsSync(configPathFor(repoRoot, 'claude'))
  ) {
    adapterName = 'claude'
    configPath = layout.configPath(repoRoot)
    hooksPath = getAdapter('claude').layout.hooksSettingsPath(repoRoot)
    corePath = runtimeCorePath(repoRoot, 'claude')
  }

  if (!existsSync(configPath)) {
    issues.push(`Missing config: ${configPath}`)
  } else {
    try {
      const rawConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
        version?: number
        adapter?: AdapterName
      }
      adapterName = resolveDoctorAdapter(options, rawConfig.adapter)
      const activeAdapter = getAdapter(adapterName)
      configPath = activeAdapter.layout.configPath(repoRoot)
      hooksPath = activeAdapter.layout.hooksSettingsPath(repoRoot)
      corePath = runtimeCorePath(repoRoot, adapterName)

      if (rawConfig.version === undefined) {
        warnings.push(
          'Config is missing "version". Set "version": 3 explicitly to avoid ambiguous migration.',
        )
      }
      loadedConfig = await loadConfigFile(repoRoot, adapterName)
      if (loadedConfig.version !== 3) {
        warnings.push(
          `Config version is ${loadedConfig.version}; expected 3. Run agent-belay upgrade to migrate.`,
        )
      }
      notes.push(`Adapter: ${adapterName}`)
      notes.push(`Config mode: ${loadedConfig.mode}`)
      const repoLocalDir = repoLocalStateDirFor(repoRoot, loadedConfig)
      if (loadedConfig.controlPlane.enabled) {
        notes.push(`Control plane: ${belayStateDir(loadedConfig, repoLocalDir)}`)
        const repoLocalPending = path.join(repoLocalDir, 'pending-approvals.json')
        const repoLocalApproved = path.join(repoLocalDir, 'approved-approvals.json')
        if (existsSync(repoLocalPending) || existsSync(repoLocalApproved)) {
          warnings.push(
            'Repo-local approval files remain while control plane is enabled. Run agent-belay doctor --fix to archive them.',
          )
        }
      } else {
        const controlPlaneDirs = new Set<string>([defaultControlPlaneDir()])
        if (loadedConfig.controlPlane.configDir) {
          controlPlaneDirs.add(loadedConfig.controlPlane.configDir)
        }
        for (const controlPlaneDir of controlPlaneDirs) {
          const hasApprovalFiles =
            existsSync(path.join(controlPlaneDir, 'pending-approvals.json')) ||
            existsSync(path.join(controlPlaneDir, 'approved-approvals.json'))
          if (hasApprovalFiles) {
            warnings.push(
              `Control plane is disabled but approval files still exist at ${controlPlaneDir}. Run agent-belay doctor --fix to migrate and archive them.`,
            )
          }
        }
      }
      if (loadedConfig.controlPlane.integrity === 'hash-pinned') {
        notes.push(
          'Integrity: hash-pinned (verify with agent-belay upgrade after runtime changes).',
        )
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'Failed to parse belay.config.json')
    }
  }

  const activeLayout = getAdapter(adapterName).layout
  const repoLocalDir = loadedConfig
    ? repoLocalStateDirFor(repoRoot, loadedConfig)
    : activeLayout.repoLocalStateDir(repoRoot)
  const hooksDir = activeLayout.hooksDir(repoRoot)
  const requiredPaths = [
    path.join(hooksDir, 'belay-runner'),
    path.join(hooksDir, 'belay-runner.cmd'),
    path.join(hooksDir, 'belay-before-submit.mjs'),
    path.join(hooksDir, 'belay-shell-gate.mjs'),
    path.join(hooksDir, 'belay-tool-gate.mjs'),
    path.join(hooksDir, 'belay-audit.mjs'),
    corePath,
    loadedConfig
      ? pendingApprovalsPath(repoRoot, loadedConfig)
      : path.join(repoLocalDir, 'pending-approvals.json'),
    loadedConfig
      ? approvedApprovalsPath(repoRoot, loadedConfig)
      : path.join(repoLocalDir, 'approved-approvals.json'),
    path.join(repoRoot, loadedConfig?.audit.logPath ?? activeLayout.defaultAuditLogPath(repoRoot)),
  ]
  for (const requiredPath of requiredPaths) {
    if (!existsSync(requiredPath)) {
      issues.push(`Missing generated file: ${requiredPath}`)
    }
  }

  let hooksOk = true
  try {
    const managedEntries = getAdapter(adapterName).hookEvents()
    if (adapterName === 'cursor') {
      const { loadHooksFile } = await import('./installer.js')
      const hooksFile = await loadHooksFile(hooksPath)
      for (const { event, definition } of managedEntries) {
        const entries = hooksFile.hooks[event] ?? []
        const present = entries.some(
          (entry) => entry.command === definition.command && entry.matcher === definition.matcher,
        )
        if (!present) {
          hooksOk = false
          const matcherSuffix = definition.matcher ? ` (matcher: ${definition.matcher})` : ''
          issues.push(`Missing managed hook for ${event}: ${definition.command}${matcherSuffix}`)
        }
      }
    } else {
      const settings = JSON.parse(await readFile(hooksPath, 'utf8')) as {
        hooks?: Record<string, unknown[]>
      }
      for (const { definition } of managedEntries) {
        const eventHooks = settings.hooks?.PreToolUse ?? []
        const present = eventHooks.some((entry) => {
          if (!entry || typeof entry !== 'object') {
            return false
          }
          const hooks = (entry as { hooks?: Array<{ command?: string }> }).hooks
          return hooks?.some((hook) => hook.command === definition.command)
        })
        if (!present && definition.matcher) {
          hooksOk = false
          issues.push(`Missing Claude managed hook command: ${definition.command}`)
        }
      }
    }
  } catch (error) {
    hooksOk = false
    issues.push(error instanceof Error ? error.message : 'Failed to parse hook settings')
  }

  const nodeResolution = resolveNodeBinary()
  if (!nodeResolution.ok) {
    issues.push(nodeResolution.detail)
  } else {
    notes.push(`Node resolved at ${nodeResolution.path}`)
  }

  if (existsSync(corePath)) {
    const runtimeVersions = await readRuntimeVersion(corePath)
    if (runtimeVersions.stamp && !runtimeVersions.stamp.startsWith(`${PACKAGE_VERSION}@`)) {
      warnings.push(
        `Installed runtime stamp (${runtimeVersions.stamp}) differs from package (${PACKAGE_VERSION}). Run agent-belay upgrade.`,
      )
    }
    if (runtimeVersions.version && runtimeVersions.version !== PACKAGE_VERSION) {
      warnings.push(
        `Installed runtime version (${runtimeVersions.version}) differs from package (${PACKAGE_VERSION}). Run agent-belay upgrade.`,
      )
    }
    if (runtimeVersions.stamp?.startsWith(`${PACKAGE_VERSION}@`)) {
      notes.push(`Runtime version matches package (${PACKAGE_VERSION}).`)
    }
  }

  if (options.fix && loadedConfig) {
    const cleanup = await cleanupOrphanApprovalState(repoRoot, loadedConfig, {
      dryRun: options.dryRun === true,
    })
    if (cleanup.actions.length > 0) {
      notes.push(...cleanup.actions)
    } else {
      notes.push('No orphan approval cleanup actions were needed.')
    }
  }

  let dogfood = null
  let oq3Spike = null
  if (loadedConfig) {
    const operational = await loadOperationalInsights({ targetDir: repoRoot })
    dogfood = operational.dogfood
    oq3Spike = operational.oq3Spike

    if (dogfood.active) {
      notes.push(
        `Dogfood active: ${dogfood.gateEvents} gate events, ${dogfood.wouldBlockCount} would-block (${(dogfood.wouldBlockRate * 100).toFixed(1)}%).`,
      )
      if (dogfood.readyForEnforce) {
        notes.push('Dogfood metrics suggest enforce mode is ready (agent-belay dogfood --enforce).')
      }
    } else if (dogfood.unknownLocalEffect === 'deny' && dogfood.mode !== 'audit') {
      notes.push('Fail-closed policy is enabled in enforce mode.')
    }

    if (loadedConfig.controlPlane.spikeOnPrompt) {
      if (oq3Spike?.ok) {
        notes.push(`OQ3 spike passed at ${oq3Spike.path}.`)
      } else if (oq3Spike) {
        warnings.push(
          `OQ3 spike failed at ${oq3Spike.path}${oq3Spike.error ? `: ${oq3Spike.error}` : ''}.`,
        )
      } else {
        warnings.push(
          'OQ3 spikeOnPrompt is enabled but oq3-spike-last.json is missing. Submit a chat prompt.',
        )
      }
    }
  }

  const report: DoctorReport = {
    ok: issues.length === 0 && hooksOk,
    repoRoot,
    configPath,
    hooksPath,
    nodeResolution,
    issues,
    notes,
    warnings,
    dogfood,
    oq3Spike,
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

  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`)
    }
  }

  if (report.dogfood) {
    lines.push(
      '',
      `Dogfood: ${report.dogfood.active ? 'active' : 'inactive'} | enforce ready: ${report.dogfood.readyForEnforce ? 'yes' : 'no'}`,
    )
    if (report.oq3Spike) {
      lines.push(`OQ3 spike: ${report.oq3Spike.ok ? 'ok' : 'failed'} (${report.oq3Spike.path})`)
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
