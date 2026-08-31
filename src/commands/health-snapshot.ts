import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getClaudeManagedHookEntries } from '../adapters/claude/hooks.js'
import { getCodexManagedHookEntries } from '../adapters/codex/hooks.js'
import { getAdapterLayout } from '../adapters/layouts/index.js'
import { resolveScopedPaths } from '../adapters/layouts/scope.js'
import type { AdapterName } from '../adapters/layouts/types.js'
import { detectAdapterName, loadLayeredConfig } from '../config-io.js'
import { diagnoseJudge } from '../core/judge-doctor.js'
import { getManagedHookEntries } from '../defaults.js'
import { sandboxStatus } from '../services/sandbox-service.js'
import type { HealthSnapshot, HealthSnapshotOptions } from '../types.js'

function skillCandidates(adapter: AdapterName, repoRoot: string): string[] {
  const projectAgent =
    adapter === 'cursor'
      ? path.join(repoRoot, '.cursor')
      : adapter === 'claude'
        ? path.join(repoRoot, '.claude')
        : path.join(repoRoot, '.codex')
  const home = os.homedir()
  const globalAgent =
    adapter === 'cursor'
      ? path.join(home, '.cursor')
      : adapter === 'claude'
        ? path.join(home, '.claude')
        : path.join(home, '.codex')

  return [
    path.join(projectAgent, 'skills', 'belay', 'SKILL.md'),
    path.join(globalAgent, 'skills', 'belay', 'SKILL.md'),
  ]
}

async function managedHooksPresent(
  adapter: AdapterName,
  hooksPath: string,
  hooksDir: string,
  repoRoot: string,
): Promise<boolean> {
  const managedEntries =
    adapter === 'cursor'
      ? getManagedHookEntries(process.platform, hooksDir, repoRoot)
      : adapter === 'claude'
        ? getClaudeManagedHookEntries(process.platform, hooksDir, repoRoot)
        : getCodexManagedHookEntries(process.platform, hooksDir, repoRoot)

  if (!existsSync(hooksPath)) {
    return false
  }

  const content = await readFile(hooksPath, 'utf8')
  if (adapter === 'cursor') {
    const hooksFile = JSON.parse(content) as {
      hooks?: Record<string, Array<{ command?: string; matcher?: string }>>
    }
    return managedEntries.every(({ event, definition }) =>
      (hooksFile.hooks?.[event] ?? []).some(
        (entry) => entry.command === definition.command && entry.matcher === definition.matcher,
      ),
    )
  }

  if (adapter === 'claude') {
    const settings = JSON.parse(content) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
    }
    return managedEntries.every(({ event, definition }) =>
      (settings.hooks?.[event] ?? []).some(
        (entry) =>
          entry.matcher === definition.matcher &&
          entry.hooks?.some((hook) => hook.command === definition.command),
      ),
    )
  }

  return managedEntries.every(({ definition }) => content.includes(definition.command))
}

/** Cursor modes confirmed not to apply host-level denial after Belay allows. */
const CURSOR_APPROVAL_MODES_WITHOUT_HOST_DENIAL = new Set(['unrestricted'])

export function cursorCliConfigPaths(
  homeDir: string,
  env: Partial<Pick<NodeJS.ProcessEnv, 'CURSOR_CONFIG_DIR' | 'XDG_CONFIG_HOME'>>,
): string[] {
  const cursorConfigDir = env.CURSOR_CONFIG_DIR?.trim()
  if (cursorConfigDir) {
    return [path.join(cursorConfigDir, 'cli-config.json')]
  }

  const candidates: string[] = []
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
  if (xdgConfigHome) {
    candidates.push(path.join(xdgConfigHome, 'cursor', 'cli-config.json'))
  }
  candidates.push(path.join(homeDir, '.cursor', 'cli-config.json'))
  return candidates
}

export function cursorApprovalModeRequiresHostDenialWarning(approvalMode: unknown): boolean {
  if (typeof approvalMode !== 'string' || !approvalMode.trim()) {
    return true
  }
  return !CURSOR_APPROVAL_MODES_WITHOUT_HOST_DENIAL.has(approvalMode)
}

export function formatCursorApprovalModeLabel(approvalMode: unknown): string {
  if (typeof approvalMode !== 'string' || !approvalMode.trim()) {
    return 'default (prompts on each action)'
  }
  return approvalMode
}

async function cursorRunModeRiskSignal(
  homeDir: string,
  belayMode: string,
  env: Partial<Pick<NodeJS.ProcessEnv, 'CURSOR_CONFIG_DIR' | 'XDG_CONFIG_HOME'>>,
): Promise<string | null> {
  const configPath = cursorCliConfigPaths(homeDir, env).find((candidate) => existsSync(candidate))
  if (!configPath) {
    return null
  }
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { approvalMode?: unknown }
    if (!cursorApprovalModeRequiresHostDenialWarning(config.approvalMode)) {
      return null
    }
    const approvalModeLabel = formatCursorApprovalModeLabel(config.approvalMode)
    const auditGuidance =
      belayMode === 'audit'
        ? ' Belay is in audit mode; keep the Cursor protection or approve the exact host prompt, and do not switch Cursor to unrestricted until Belay enforce mode and fail-closed hook health are verified.'
        : ' If Belay is intended to be authoritative, verify fail-closed hook health before configuring Cursor unrestricted mode.'
    return `Cursor approval mode is ${approvalModeLabel}; Cursor can deny shell actions after Belay allows them. Such a denial is a host-policy denial, not a Belay approval.${auditGuidance}`
  } catch {
    return null
  }
}

/** Lightweight floor check without judge doctor / sandbox probes. */
export async function isBelayFloorInstalled(
  options: { targetDir?: string; adapter?: AdapterName } = {},
): Promise<boolean> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const adapter: AdapterName = options.adapter ?? detectAdapterName(repoRoot)
  const layout = getAdapterLayout(adapter)
  const configPath = layout.configPath(repoRoot)
  if (!existsSync(configPath)) {
    return false
  }

  let installScope: 'project' | 'global' = 'project'
  try {
    const layered = await loadLayeredConfig(repoRoot, adapter)
    installScope = layered.config.installScope === 'global' ? 'global' : 'project'
  } catch {
    return false
  }

  const scopedPaths = resolveScopedPaths(layout, installScope, repoRoot)
  const hooksPath = scopedPaths.hooksSettingsPath
  const hooksDir = scopedPaths.hooksDir
  const corePath = path.join(scopedPaths.runtimeDir, 'core.mjs')
  const runtimePresent = existsSync(corePath)
  const runnerPresent =
    existsSync(path.join(hooksDir, 'belay-runner')) ||
    existsSync(path.join(hooksDir, 'belay-runner.cmd'))
  if (!existsSync(hooksPath) || !runnerPresent || !runtimePresent) {
    return false
  }

  try {
    return await managedHooksPresent(adapter, hooksPath, hooksDir, repoRoot)
  } catch {
    return false
  }
}

export async function collectHealthSnapshot(
  options: HealthSnapshotOptions = {},
): Promise<HealthSnapshot> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const adapter: AdapterName = options.adapter ?? detectAdapterName(repoRoot)
  const layout = getAdapterLayout(adapter)
  const configPath = layout.configPath(repoRoot)

  let configPresent = existsSync(configPath)
  let installScope: 'project' | 'global' = 'project'
  let judgeIssues: string[] = []
  let judgeWarnings: string[] = []
  let judgeNotes: string[] = []
  let containmentPosture: HealthSnapshot['containmentPosture'] = 'best-effort'
  let containmentWarnings: string[] = []
  const additionalRiskSignals: string[] = []
  let l1FullActive = false

  if (configPresent) {
    try {
      const layered = await loadLayeredConfig(repoRoot, adapter)
      installScope = layered.config.installScope === 'global' ? 'global' : 'project'
      const judgeDoctor = await diagnoseJudge(layered.config)
      judgeIssues = judgeDoctor.issues
      judgeWarnings = judgeDoctor.warnings
      judgeNotes = judgeDoctor.notes
      const sandbox = await sandboxStatus({ targetDir: repoRoot })
      l1FullActive = sandbox.l1FullActive
      containmentPosture = l1FullActive ? 'l1-full' : 'best-effort'

      if (!layered.config.sandbox.enabled || layered.config.sandbox.runtime === 'none') {
        containmentWarnings.push('sandbox runtime is not enabled')
      }
      if (!layered.config.egress.enabled) {
        containmentWarnings.push('egress proxy is not enabled')
      } else if (!sandbox.l1Full.egressProxyRunning) {
        containmentWarnings.push('egress proxy is not running for this repository')
      }
      if (layered.config.controlPlane.isolation.mode === 'none') {
        containmentWarnings.push('control-plane isolation mode is none')
      }
      if (!layered.config.approvalSigning.required) {
        containmentWarnings.push('approval signing is not required')
      }
      if (layered.config.judge.provider === 'openai-compatible') {
        additionalRiskSignals.push(
          'cloud judge enabled: redacted command text may be sent to an external provider',
        )
      }
      if (adapter === 'cursor') {
        const cursorRunModeRisk = await cursorRunModeRiskSignal(
          options.homeDir ?? os.homedir(),
          layered.config.mode,
          options.cursorConfigEnv ?? {
            CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
          },
        )
        if (cursorRunModeRisk) {
          additionalRiskSignals.push(cursorRunModeRisk)
        }
      }
    } catch {
      configPresent = false
    }
  }

  if (!configPresent) {
    containmentWarnings = ['belay config is missing or unreadable']
  }

  const scopedPaths = resolveScopedPaths(layout, installScope, repoRoot)
  const hooksPath = scopedPaths.hooksSettingsPath
  const hooksDir = scopedPaths.hooksDir
  const corePath = path.join(scopedPaths.runtimeDir, 'core.mjs')
  const skillPath = path.join(scopedPaths.skillsDir, 'SKILL.md')
  const commandsPath = scopedPaths.commandsDir
    ? path.join(scopedPaths.commandsDir, 'belay-approve.md')
    : undefined

  const runtimePresent = existsSync(corePath)
  const runnerPresent =
    existsSync(path.join(hooksDir, 'belay-runner')) ||
    existsSync(path.join(hooksDir, 'belay-runner.cmd'))
  const hooksInstalled = existsSync(hooksPath) && runnerPresent

  let managedHooksOk = false
  if (hooksInstalled) {
    try {
      managedHooksOk = await managedHooksPresent(adapter, hooksPath, hooksDir, repoRoot)
    } catch {
      managedHooksOk = false
    }
  }

  const skillInstalled =
    existsSync(skillPath) ||
    skillCandidates(adapter, repoRoot).some((candidate) => existsSync(candidate))

  const floorInstalled = configPresent && hooksInstalled && managedHooksOk && runtimePresent
  const skillOnly = skillInstalled && !floorInstalled

  const missingArtifacts: string[] = []
  if (configPresent) {
    for (const artifact of [
      path.join(hooksDir, 'belay-runner'),
      path.join(hooksDir, 'belay-before-submit.mjs'),
      path.join(hooksDir, 'belay-shell-gate.mjs'),
      path.join(hooksDir, 'belay-tool-gate.mjs'),
      corePath,
    ]) {
      if (!existsSync(artifact)) {
        missingArtifacts.push(artifact)
      }
    }
  }

  return {
    repoRoot,
    adapter,
    installScope,
    configPath,
    hooksPath,
    skillPath,
    commandsPath,
    configPresent,
    hooksInstalled,
    managedHooksOk,
    runtimePresent,
    skillInstalled,
    skillOnly,
    commandsInstalled: commandsPath ? existsSync(commandsPath) : false,
    floorInstalled,
    missingArtifacts,
    judgeIssues,
    judgeWarnings,
    judgeNotes,
    containmentPosture,
    containmentWarnings,
    additionalRiskSignals,
    l1FullActive,
  }
}
