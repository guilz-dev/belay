import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { getClaudeManagedHookEntries } from '../adapters/claude/hooks.js'
import { getCodexManagedHookEntries } from '../adapters/codex/hooks.js'
import { hasCurrentCursorDispatcherGeneration } from '../adapters/cursor/dispatcher-generation.js'
import {
  hasDuplicateCursorShellGates,
  hasManagedCursorHookEntries,
} from '../adapters/cursor/hooks.js'
import { getAdapterLayout } from '../adapters/layouts/index.js'
import { protectedArtifactRoots } from '../adapters/layouts/protected-paths.js'
import { resolveScopedPaths } from '../adapters/layouts/scope.js'
import { cleanupOrphanApprovalState } from '../cleanup-orphans.js'
import {
  approvedApprovalsPath,
  belayStateDir,
  detectAdapterName,
  loadLayeredConfig,
  pendingApprovalsPath,
  repoLocalStateDirFor,
  writeConfigFile,
} from '../config-io.js'
import { approvalSigningKeyPath } from '../core/approval-token.js'
import { auditRecordHasLegacyCorrelationPlaceholders } from '../core/audit-legacy-archive.js'
import { detectFenceDrift, summarizeAuditVisibility } from '../core/audit-summary.js'
import { inspectBoundaryAttestationFile } from '../core/capability/boundary-attestation-sign.js'
import {
  boundaryAttestationPath,
  boundarySessionStatus,
} from '../core/capability/boundary-session.js'
import {
  configuredControlPlaneDir,
  defaultControlPlaneDir,
  hasForbiddenShellOverrideLists,
  stripForbiddenShellOverrideLists,
} from '../core/config.js'
import { verifyIntegrityManifest } from '../core/integrity.js'
import { diagnoseJudge, stopJudgeSessionBrokers } from '../core/judge-doctor.js'
import { resolveJudgeTransport } from '../core/judge-runtime-detection.js'
import { listRecoveryCheckpoints } from '../core/recovery/checkpoint.js'
import {
  recoveryApprovalSetupNotes,
  recoveryNotificationConfigured,
  recoveryNotificationSetupWarning,
  summarizeRecoveryCheckpointDiagnostics,
} from '../core/recovery/operator-guidance.js'
import { probeFileCheckpointBackend } from '../core/transactional/backend-selector.js'
import { fileCheckpointIsolationReason } from '../core/transactional/file-checkpoint-isolation.js'
import { probeFileCloneStrategy } from '../core/transactional/file-clone.js'
import { isGitWorktreeAvailable } from '../core/transactional/git-worktree.js'
import { getManagedHookEntries } from '../defaults.js'
import { resolveNodeBinary } from '../node-resolution.js'
import { matchesAuditCohort, readInstalledRuntimeProvenance } from '../runtime-provenance.js'
import { egressStatus } from '../services/egress-service.js'
import { sandboxStatus } from '../services/sandbox-service.js'
import type { AdapterName, DoctorOptions, DoctorReport } from '../types.js'
import { PACKAGE_VERSION } from '../version.js'
import { loadAuditRecords } from './audit.js'
import { collectHealthSnapshot } from './health-snapshot.js'
import { metricsProject } from './metrics.js'

function resolveDoctorAdapter(options: DoctorOptions, configAdapter?: AdapterName): AdapterName {
  if (options.adapter) {
    return options.adapter
  }
  if (configAdapter === 'claude' || configAdapter === 'codex') {
    return configAdapter
  }
  return 'cursor'
}

function hasCursorGlobalWorkspaceResolver(runtimeSource: string): boolean {
  // Cursor global hooks must derive workspace cwd from payload fields, not process cwd.
  const hasScopedToolResolver =
    runtimeSource.includes('resolveCursorToolActionCwd') ||
    runtimeSource.includes('includeToolInputCwd')
  return (
    runtimeSource.includes('resolveCursorActionCwd') &&
    hasScopedToolResolver &&
    runtimeSource.includes('workspace_roots') &&
    runtimeSource.includes('working_directory') &&
    runtimeSource.includes('tool_input')
  )
}

const CURSOR_HOOK_SHIMS = [
  'belay-before-submit.mjs',
  'belay-shell-gate.mjs',
  'belay-tool-gate.mjs',
  'belay-audit.mjs',
] as const

function runnerFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'belay-runner.ps1' : 'belay-runner'
}

async function cursorOriginIssues(
  hooksDir: string,
  installScope: 'project' | 'global',
  repoRoot: string,
): Promise<string[]> {
  const canonicalRepoRoot = realpathSync(repoRoot)
  const issues: string[] = []
  for (const fileName of CURSOR_HOOK_SHIMS) {
    const shimPath = path.join(hooksDir, fileName)
    if (!existsSync(shimPath)) {
      continue
    }
    const source = await readFile(shimPath, 'utf8')
    if (!source.includes("from '../belay/runtime/dispatcher.mjs'")) {
      issues.push(
        `Cursor router generation mismatch for intended ${installScope} owner: ${shimPath}. Run belay upgrade --scope ${installScope}.`,
      )
      continue
    }
    const originMatch = source.match(/origin:\s*(\{[^\n]+\})/)
    let originMatches = false
    if (originMatch?.[1]) {
      try {
        const origin = JSON.parse(originMatch[1]) as {
          scope?: unknown
          repoRoot?: unknown
        }
        originMatches =
          installScope === 'global'
            ? origin.scope === 'global'
            : origin.scope === 'project' &&
              typeof origin.repoRoot === 'string' &&
              realpathSync(origin.repoRoot) === canonicalRepoRoot
      } catch {
        originMatches = false
      }
    }
    if (!originMatches) {
      issues.push(
        `Cursor hook origin mismatch for intended ${installScope} owner: ${shimPath}. Run belay upgrade --scope ${installScope}.`,
      )
    }
  }
  return issues
}

export async function doctorProject(options: DoctorOptions = {}): Promise<DoctorReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const issues: string[] = []
  const notes: string[] = []
  const warnings: string[] = []

  let loadedConfig = null
  let configProvenance: DoctorReport['configProvenance'] = []
  let adapterName: AdapterName = options.adapter ?? detectAdapterName(repoRoot)
  let activeLayout = getAdapterLayout(adapterName)
  let configPath = activeLayout.configPath(repoRoot)
  let hooksPath = activeLayout.hooksSettingsPath(repoRoot)
  let corePath = path.join(activeLayout.runtimeDir(repoRoot), 'core.mjs')

  if (!existsSync(configPath)) {
    issues.push(`Missing config: ${configPath}`)
    notes.push(
      'No belay config found. Run `belay config` for interactive setup, or `belay init` for non-interactive install.',
    )
  } else {
    try {
      const rawConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
        version?: number
        adapter?: AdapterName
      }
      adapterName = resolveDoctorAdapter(options, rawConfig.adapter)
      activeLayout = getAdapterLayout(adapterName)
      configPath = activeLayout.configPath(repoRoot)
      hooksPath = activeLayout.hooksSettingsPath(repoRoot)
      corePath = path.join(activeLayout.runtimeDir(repoRoot), 'core.mjs')

      if (rawConfig.version === undefined) {
        warnings.push(
          'Config is missing "version". Set "version": 3 explicitly to avoid ambiguous migration.',
        )
      }
      const layered = await loadLayeredConfig(repoRoot, adapterName)
      loadedConfig = layered.config
      configProvenance = layered.provenance
      for (const entry of layered.provenance) {
        notes.push(`Config layer [${entry.source}]: ${entry.path}`)
      }
      const ignoredShellOverrideLists = [
        ...(loadedConfig.overrides.allow.length > 0 ? ['overrides.allow'] : []),
        ...(loadedConfig.overrides.external.length > 0 ? ['overrides.external'] : []),
      ]
      if (ignoredShellOverrideLists.length > 0) {
        issues.push(
          `Legacy shell ${ignoredShellOverrideLists.join(' and ')} ${
            ignoredShellOverrideLists.length === 1 ? 'is' : 'are'
          } forbidden (ADR-005). Remove the command list (or run belay doctor --fix); improve EffectPlan semantics, use one-shot approval, or approve an exact resource scope instead.`,
        )
      }
      if (loadedConfig.version !== 4) {
        warnings.push(
          `Config version is ${loadedConfig.version}; expected 4. Run belay upgrade to migrate.`,
        )
      }
      const transport = resolveJudgeTransport(loadedConfig.judge)
      const shouldProbe = transport.endsWith('-cli')
      const judgeDoctor = await diagnoseJudge(loadedConfig, repoRoot, { liveProbe: shouldProbe })
      issues.push(...judgeDoctor.issues)
      warnings.push(...judgeDoctor.warnings)
      notes.push(...judgeDoctor.notes)
      notes.push(`Adapter: ${adapterName}`)
      const installScope = loadedConfig.installScope === 'global' ? 'global' : 'project'
      const scopedPaths = resolveScopedPaths(activeLayout, installScope, repoRoot)
      hooksPath = scopedPaths.hooksSettingsPath
      corePath = path.join(scopedPaths.runtimeDir, 'core.mjs')
      notes.push(
        installScope === 'global'
          ? adapterName === 'cursor'
            ? `Install scope: global (hooks/runtime at ${scopedPaths.hooksDir}). To remove global hooks: belay uninstall --scope global`
            : `Install scope: global (hooks/runtime at ${scopedPaths.hooksDir})`
          : 'Install scope: project',
      )
      notes.push(`Config mode: ${loadedConfig.mode}`)
      const dogfoodActive =
        loadedConfig.mode === 'audit' && loadedConfig.policy.unknownLocalEffect === 'deny'
      const allGatesDisabled =
        !loadedConfig.gates.shell &&
        !loadedConfig.gates.toolShell &&
        !loadedConfig.gates.fileMutation &&
        !loadedConfig.gates.subagent
      if (dogfoodActive && allGatesDisabled) {
        issues.push(
          'Dogfood audit mode is active but all gates are disabled; gate events will not be recorded. Enable gates.shell, gates.toolShell, gates.fileMutation, and/or gates.subagent.',
        )
      }
      notes.push(
        'Verdict engine (Tier0 + Tier1; location × opacity × effect × confidence). Audit records include schemaVersion 2 axes when available.',
      )
      const repoLocalDir = repoLocalStateDirFor(repoRoot, loadedConfig)
      if (loadedConfig.controlPlane.enabled) {
        notes.push(`Control plane: ${belayStateDir(loadedConfig, repoLocalDir)}`)
        const repoLocalPending = path.join(repoLocalDir, 'pending-approvals.json')
        const repoLocalApproved = path.join(repoLocalDir, 'approved-approvals.json')
        if (existsSync(repoLocalPending) || existsSync(repoLocalApproved)) {
          warnings.push(
            'Repo-local approval files remain while control plane is enabled. Run belay doctor --fix to archive them.',
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
              `Control plane is disabled but approval files still exist at ${controlPlaneDir}. Run belay doctor --fix to migrate and archive them.`,
            )
          }
        }
      }
      if (loadedConfig.controlPlane.integrity === 'hash-pinned') {
        notes.push('Integrity: hash-pinned (verify with belay upgrade after runtime changes).')
        const integrity = await verifyIntegrityManifest(repoRoot, activeLayout)
        if (!integrity.ok) {
          issues.push(
            `Integrity verification failed: ${integrity.mismatches.slice(0, 3).join(', ')}`,
          )
        }
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'Failed to parse belay.config.json')
    }
  }

  const installScope = loadedConfig?.installScope === 'global' ? 'global' : 'project'
  const scopedPaths = resolveScopedPaths(activeLayout, installScope, repoRoot)
  hooksPath = scopedPaths.hooksSettingsPath
  corePath = path.join(scopedPaths.runtimeDir, 'core.mjs')
  const hooksDir = scopedPaths.hooksDir
  const repoLocalDir = loadedConfig
    ? repoLocalStateDirFor(repoRoot, loadedConfig)
    : activeLayout.repoLocalStateDir(repoRoot)
  const routingOwnerPaths = [
    path.join(hooksDir, runnerFileName(process.platform)),
    path.join(hooksDir, 'belay-before-submit.mjs'),
    path.join(hooksDir, 'belay-shell-gate.mjs'),
    path.join(hooksDir, 'belay-tool-gate.mjs'),
    path.join(hooksDir, 'belay-audit.mjs'),
    ...(adapterName === 'cursor' ? [path.join(scopedPaths.runtimeDir, 'dispatcher.mjs')] : []),
    corePath,
  ]
  const operationalPaths = [
    loadedConfig
      ? pendingApprovalsPath(repoRoot, loadedConfig)
      : path.join(repoLocalDir, 'pending-approvals.json'),
    loadedConfig
      ? approvedApprovalsPath(repoRoot, loadedConfig)
      : path.join(repoLocalDir, 'approved-approvals.json'),
    path.join(repoRoot, loadedConfig?.audit.logPath ?? activeLayout.defaultAuditLogPath(repoRoot)),
  ]
  const requiredPaths = [...routingOwnerPaths, ...operationalPaths]
  for (const requiredPath of requiredPaths) {
    if (!existsSync(requiredPath)) {
      issues.push(`Missing generated file: ${requiredPath}`)
      if (adapterName === 'cursor' && routingOwnerPaths.includes(requiredPath)) {
        issues.push(
          `Cursor intended ${installScope} owner is incomplete: missing ${requiredPath}. Run belay upgrade --scope ${installScope}.`,
        )
      }
    }
  }
  if (adapterName === 'cursor') {
    issues.push(...(await cursorOriginIssues(hooksDir, installScope, repoRoot)))
    const dispatcherPath = path.join(scopedPaths.runtimeDir, 'dispatcher.mjs')
    if (
      existsSync(dispatcherPath) &&
      !hasCurrentCursorDispatcherGeneration(await readFile(dispatcherPath, 'utf8'))
    ) {
      issues.push(
        `Cursor router generation mismatch for intended ${installScope} owner dispatcher: ${dispatcherPath}. Run belay upgrade --scope ${installScope}.`,
      )
    }
    if (installScope === 'project') {
      const globalPaths = resolveScopedPaths(activeLayout, 'global', repoRoot)
      if (existsSync(globalPaths.hooksSettingsPath)) {
        const { loadHooksFile } = await import('../installer.js')
        const globalHooks = await loadHooksFile(globalPaths.hooksSettingsPath)
        if (
          hasManagedCursorHookEntries(globalHooks, process.platform, globalPaths.hooksDir, repoRoot)
        ) {
          const globalOwnerFiles = [
            path.join(globalPaths.hooksDir, runnerFileName(process.platform)),
            path.join(globalPaths.runtimeDir, 'core.mjs'),
            path.join(globalPaths.runtimeDir, 'dispatcher.mjs'),
            ...CURSOR_HOOK_SHIMS.map((fileName) => path.join(globalPaths.hooksDir, fileName)),
          ]
          const globalProblems = [
            ...globalOwnerFiles.filter((filePath) => !existsSync(filePath)),
            ...(await cursorOriginIssues(globalPaths.hooksDir, 'global', repoRoot)),
          ]
          const globalDispatcherPath = path.join(globalPaths.runtimeDir, 'dispatcher.mjs')
          if (
            existsSync(globalDispatcherPath) &&
            !hasCurrentCursorDispatcherGeneration(await readFile(globalDispatcherPath, 'utf8'))
          ) {
            globalProblems.push(globalDispatcherPath)
          }
          if (globalProblems.length > 0) {
            issues.push(
              'Global Cursor installation cannot yield to the project owner. Run belay upgrade from this project to refresh the global router.',
            )
          } else {
            notes.push(
              'Healthy global Cursor install is shadowed by this project owner and will return neutral for this repository.',
            )
          }
        }
      }
    }
  }

  let hooksOk = true
  try {
    const managedEntries =
      adapterName === 'cursor'
        ? getManagedHookEntries(process.platform, hooksDir, repoRoot)
        : adapterName === 'claude'
          ? getClaudeManagedHookEntries(process.platform, hooksDir, repoRoot)
          : getCodexManagedHookEntries(process.platform, hooksDir, repoRoot)
    if (adapterName === 'cursor') {
      const { loadHooksFile } = await import('../installer.js')
      const hooksFile = await loadHooksFile(hooksPath)
      for (const { event, definition } of managedEntries) {
        const entries = hooksFile.hooks[event] ?? []
        const present = entries.some(
          (entry: { command?: string; matcher?: string }) =>
            entry.command === definition.command && entry.matcher === definition.matcher,
        )
        if (!present) {
          hooksOk = false
          const matcherSuffix = definition.matcher ? ` (matcher: ${definition.matcher})` : ''
          issues.push(`Missing managed hook for ${event}: ${definition.command}${matcherSuffix}`)
        }
      }
      if (hasDuplicateCursorShellGates(hooksFile, process.platform, hooksDir, repoRoot)) {
        warnings.push(
          'Duplicate Cursor Shell preToolUse gates detected. Run belay upgrade to dedupe managed hooks.',
        )
      }
    } else if (adapterName === 'codex') {
      // Codex hooks live in TOML (.codex/config.toml). Verify belay's managed command strings
      // are present in the rendered TOML block.
      const toml = await readFile(hooksPath, 'utf8')
      for (const { event, definition } of managedEntries) {
        if (!toml.includes(definition.command)) {
          hooksOk = false
          issues.push(`Missing Codex managed hook for ${event}: ${definition.command}`)
        }
      }
      // Codex adapter: shell gating VERIFIED end-to-end on Codex TUI (PreToolUse deny honored;
      // Codex TUI smoke / G-B2). Surface only the residual caveats so users know the boundary.
      warnings.push(
        'Codex adapter: shell gating verified on Codex TUI (PreToolUse deny honored). Residual ' +
          'caveats — only the shell (Bash) tool is confirmed; non-shell tool names (apply_patch ' +
          'etc.) are best-guess mappings; unmapped tools ask with pending approval (R39); managed ' +
          '(pre-trusted) deployment is not yet available; non-managed hooks require /hooks trust. ' +
          'See docs/adapter-sdk.md and docs/gates/G-B1-cursor-skill-ux.md.',
      )
    } else {
      const settings = JSON.parse(await readFile(hooksPath, 'utf8')) as {
        hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
      }
      for (const { event, definition } of managedEntries) {
        const eventHooks = settings.hooks?.[event] ?? []
        const present = eventHooks.some(
          (entry) =>
            entry.matcher === definition.matcher &&
            entry.hooks?.some((hook) => hook.command === definition.command),
        )
        if (!present) {
          hooksOk = false
          issues.push(`Missing Claude managed hook for ${event}: ${definition.command}`)
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
    const runtimeVersions = await readInstalledRuntimeProvenance(corePath)
    if (runtimeVersions.stamp && !runtimeVersions.stamp.startsWith(`${PACKAGE_VERSION}@`)) {
      warnings.push(
        `Installed runtime stamp (${runtimeVersions.stamp}) differs from package (${PACKAGE_VERSION}). Run belay upgrade.`,
      )
    }
    if (runtimeVersions.version && runtimeVersions.version !== PACKAGE_VERSION) {
      warnings.push(
        `Installed runtime version (${runtimeVersions.version}) differs from package (${PACKAGE_VERSION}). Run belay upgrade.`,
      )
    }
    if (runtimeVersions.stamp?.startsWith(`${PACKAGE_VERSION}@`)) {
      notes.push(`Runtime version matches package (${PACKAGE_VERSION}).`)
    }
    if (adapterName === 'cursor' && installScope === 'global') {
      try {
        const runtimeSource = await readFile(corePath, 'utf8')
        if (!hasCursorGlobalWorkspaceResolver(runtimeSource)) {
          warnings.push(
            'Global Cursor runtime appears to resolve hook context from hook process cwd. Per-repository belay.config.json can be bypassed (audit may act as enforce). Run belay upgrade --scope global from the latest package.',
          )
        }
      } catch {
        warnings.push(
          'Unable to inspect global Cursor runtime for workspace-cwd resolution. Run belay upgrade --scope global from the latest package.',
        )
      }
    }
  }

  if (options.fix && loadedConfig) {
    if (hasForbiddenShellOverrideLists(loadedConfig)) {
      if (options.dryRun !== true) {
        const stripped = stripForbiddenShellOverrideLists(loadedConfig)
        await writeConfigFile(repoRoot, stripped, adapterName)
        loadedConfig = stripped
        notes.push(
          'Removed forbidden legacy shell override lists (overrides.allow / overrides.external).',
        )
        for (let index = issues.length - 1; index >= 0; index -= 1) {
          const issue = issues[index] ?? ''
          if (issue.includes('overrides.allow') || issue.includes('overrides.external')) {
            issues.splice(index, 1)
          }
        }
      } else {
        notes.push('Dry run: would remove forbidden legacy shell override lists.')
      }
    }

    const cleanup = await cleanupOrphanApprovalState(repoRoot, loadedConfig, {
      dryRun: options.dryRun === true,
    })
    if (cleanup.actions.length > 0) {
      notes.push(...cleanup.actions)
    } else {
      notes.push('No orphan approval cleanup actions were needed.')
    }

    const judgeStateDir = belayStateDir(loadedConfig, repoLocalDir)
    if (options.dryRun !== true) {
      const stoppedBrokers = await stopJudgeSessionBrokers(repoRoot, judgeStateDir)
      if (stoppedBrokers > 0) {
        notes.push(`Stopped judge session broker artifacts for ${repoRoot}.`)
      }
    } else {
      notes.push('Dry run: would stop judge session broker and clear kill switch if present.')
    }
  }

  let dogfood = null
  if (loadedConfig) {
    const auditRecords = await loadAuditRecords(repoRoot)
    const metrics = await metricsProject({ targetDir: repoRoot })
    const cohortIdentity = metrics.currentCohort.identity
    const cohortAuditRecords = cohortIdentity
      ? auditRecords.filter((record) => matchesAuditCohort(record, cohortIdentity))
      : []
    const gateDecisionRecords = cohortAuditRecords.filter(
      (record) => record.kind === 'shell' || record.kind === 'tool' || record.kind === 'subagent',
    )
    if (
      gateDecisionRecords
        .slice(0, 200)
        .some((record) => auditRecordHasLegacyCorrelationPlaceholders(record))
    ) {
      warnings.push(
        'Gate audit records contain scrub placeholders in correlation fields (<timestamp>, <high-entropy>, <approval-id>). Historical metrics are unreliable until a schema v3 cohort is collected.',
      )
    }
    const auditVisibility = summarizeAuditVisibility(cohortAuditRecords)
    const drift = detectFenceDrift(auditVisibility, {
      threshold: loadedConfig.policy.fenceWarnThreshold,
    })
    warnings.push(...drift.warnings)
    notes.push(...drift.notes)

    const cohort = metrics.currentCohort
    dogfood = {
      active: loadedConfig.mode === 'audit' && loadedConfig.policy.unknownLocalEffect === 'deny',
      mode: loadedConfig.mode,
      unknownLocalEffect: loadedConfig.policy.unknownLocalEffect,
      readyForEnforce: metrics.dogfood.readyForEnforce,
      gateEvents: cohort.gateEvents,
      wouldBlockCount: cohort.wouldBlockCount,
      wouldBlockRate: cohort.wouldBlockRate,
      excludedGateEvents: cohort.excludedGateEvents,
      runtimeBuildStamp: cohort.identity?.runtimeBuildStamp,
      configFingerprint: cohort.identity?.configFingerprint,
      notes: metrics.dogfood.notes,
    }

    if (dogfood.active) {
      notes.push(
        `Dogfood active cohort: ${dogfood.gateEvents} gate events, ${dogfood.wouldBlockCount} would-block (${(dogfood.wouldBlockRate * 100).toFixed(1)}%); ${dogfood.excludedGateEvents} historical/mismatched event(s) excluded.`,
      )
      if (dogfood.readyForEnforce) {
        notes.push('Dogfood metrics suggest enforce mode is ready (belay dogfood --enforce).')
      }
    } else if (dogfood.unknownLocalEffect === 'deny' && dogfood.mode !== 'audit') {
      notes.push('Fail-closed policy is enabled in enforce mode.')
    }

    const recoveryCohort = metrics.currentCohortRecovery
    const restoreTotal =
      recoveryCohort.restore.applied +
      recoveryCohort.restore.conflict +
      recoveryCohort.restore.rejected
    if (recoveryCohort.snapshot.attempts > 0 || restoreTotal > 0) {
      notes.push(
        `Recovery cohort metrics: ${recoveryCohort.snapshot.attempts} snapshot attempt(s) (${recoveryCohort.snapshot.applied} applied, ${recoveryCohort.snapshot.skipped} skipped); restore outcomes ${recoveryCohort.restore.applied} applied / ${recoveryCohort.restore.conflict} conflict / ${recoveryCohort.restore.rejected} rejected.`,
      )
      if (recoveryCohort.snapshot.prepareSampleCount > 0) {
        notes.push(
          `Recovery snapshot prepare latency (cohort): p50 ${recoveryCohort.snapshot.prepareMsP50 ?? 0}ms, p95 ${recoveryCohort.snapshot.prepareMsP95 ?? 0}ms (${recoveryCohort.snapshot.prepareSampleCount} samples).`,
        )
      }
      if (Object.keys(recoveryCohort.snapshot.failuresByReason).length > 0) {
        notes.push(
          `Recovery snapshot failures (cohort): ${Object.entries(
            recoveryCohort.snapshot.failuresByReason,
          )
            .map(([reason, count]) => `${reason}=${count}`)
            .join(', ')}.`,
        )
      }
    }

    if (loadedConfig.policy.transactional.enabled) {
      notes.push(
        'Transactional execution: enabled — low-confidence shell mutations run in an isolated git worktree or file-checkpoint mirror; observed-safe effects are applied once and the hook denies re-execution.',
      )
      const fileCheckpointEnabled = loadedConfig.policy.transactional.fileCheckpoint.enabled
      const allowNonGit = loadedConfig.policy.transactional.fileCheckpoint.allowNonGit
      if (!existsSync(path.join(repoRoot, '.git')) && !(fileCheckpointEnabled && allowNonGit)) {
        warnings.push(
          'Transactional execution is enabled but this directory is not a git repository. Enable file checkpoint with allowNonGit or initialize git before transactional recovery can run.',
        )
      }
    }

    const fileCheckpoint = loadedConfig.policy.transactional.fileCheckpoint
    if (fileCheckpoint.enabled) {
      const copyStrategy = await probeFileCloneStrategy()
      notes.push(
        `File checkpoint: enabled (copyStrategy=${copyStrategy}, non-Git=${fileCheckpoint.allowNonGit}, maxFiles=${fileCheckpoint.maxFiles}, maxSourceBytes=${fileCheckpoint.maxSourceBytes}, maxWorkspaceBytes=${fileCheckpoint.maxWorkspaceBytes}, prepareTimeoutMs=${fileCheckpoint.prepareTimeoutMs}, copyConcurrency=${fileCheckpoint.copyConcurrency}).`,
      )
      if (!loadedConfig.policy.transactional.enabled) {
        warnings.push(
          'File checkpoint is enabled but transactional execution is disabled; dirty Git workspaces cannot use the backend.',
        )
      }
      if (!loadedConfig.policy.transactional.checkpoint?.enabled) {
        warnings.push(
          'File checkpoint is enabled but durable Recovery checkpointing is disabled; backend selection will fail closed.',
        )
      }
      const checkpointConfig = loadedConfig.policy.transactional.checkpoint
      const configuredBoundary =
        loadedConfig.capability?.boundaryDriver ??
        (loadedConfig.sandbox.runtime === 'container' ? 'container' : null)
      let attestation = null
      if (configuredBoundary) {
        try {
          const session = await boundarySessionStatus({ repoRoot, config: loadedConfig })
          attestation = session.attestation
        } catch {
          attestation = null
        }
      }
      const gitAvailable = await isGitWorktreeAvailable(repoRoot)
      const backendContext = {
        repoRoot,
        stateDir: belayStateDir(loadedConfig, repoLocalDir),
        cwd: repoRoot,
        dirtyIgnoreRoots: protectedArtifactRoots(
          activeLayout,
          repoRoot,
          loadedConfig.controlPlane.enabled ? configuredControlPlaneDir(loadedConfig) : null,
        ),
        fileCheckpoint,
        durableCheckpointEnabled: checkpointConfig?.enabled === true,
        boundaryAttestation: attestation,
        boundaryAttestationFresh: false,
        boundaryDriverId: configuredBoundary ?? undefined,
      }
      const isolationAvailable = fileCheckpointIsolationReason(backendContext) === null
      const fileCheckpointProbe = await probeFileCheckpointBackend(backendContext)
      const fileCheckpointAvailable =
        loadedConfig.policy.transactional.enabled && fileCheckpointProbe.eligible
      notes.push(
        `File checkpoint eligibility: probe=${fileCheckpointAvailable ? 'available' : 'unavailable'}, workspace=${gitAvailable ? 'git' : 'non-git'}, isolation=${isolationAvailable ? (configuredBoundary ?? 'attested') : 'unavailable'}.`,
      )
    }

    if (loadedConfig.policy.transactional.checkpoint?.enabled) {
      notes.push(
        'Recovery checkpoint: enabled — repo-local pre-images are persisted before observed-safe transactional apply.',
      )
      notes.push(...recoveryApprovalSetupNotes())
      if (!recoveryNotificationConfigured(loadedConfig)) {
        warnings.push(recoveryNotificationSetupWarning())
      }
      const signingKeyPath = approvalSigningKeyPath(
        loadedConfig.controlPlane.enabled
          ? belayStateDir(loadedConfig, repoLocalDir)
          : (loadedConfig.controlPlane.configDir ?? defaultControlPlaneDir()),
      )
      if (!existsSync(signingKeyPath)) {
        notes.push(
          `Approval signing key not yet created at ${signingKeyPath}; it will be generated on the first signed recovery approval request.`,
        )
      }
      if (!loadedConfig.policy.transactional.enabled) {
        warnings.push(
          'Recovery checkpoint is enabled but transactional execution is disabled; checkpoints will not be created until transactional execution is enabled.',
        )
      }
      try {
        const stateDir = belayStateDir(loadedConfig, repoLocalDir)
        const checkpoints = await listRecoveryCheckpoints(stateDir, repoRoot)
        if (checkpoints.length > 0) {
          notes.push(`Recovery checkpoints in this repository: ${checkpoints.length}.`)
        }
        const advisories = summarizeRecoveryCheckpointDiagnostics(checkpoints)
        warnings.push(...advisories)
      } catch {
        // Checkpoint inspection is advisory only.
      }
    }

    if (loadedConfig.sandbox.enabled) {
      const sandbox = await sandboxStatus({ targetDir: repoRoot })
      notes.push(
        `Sandbox capability broker: enabled (runtime=${loadedConfig.sandbox.runtime}, fs-scope entries=${sandbox.fsScopeAllowlistCount}, full-isolation=${sandbox.l1FullActive}).`,
      )
      if (loadedConfig.sandbox.runtime === 'none') {
        warnings.push('sandbox.enabled is true but sandbox.runtime is none.')
      }
      for (const issue of sandbox.issues) {
        warnings.push(issue)
      }
      for (const advisory of sandbox.advisories) {
        warnings.push(advisory)
      }
    }

    const boundaryDriver =
      loadedConfig.capability?.boundaryDriver ??
      (loadedConfig.sandbox.runtime === 'container' ? 'container' : null)
    if (
      loadedConfig.policy.transactional.fileCheckpoint.enabled &&
      boundaryDriver !== 'container'
    ) {
      warnings.push(
        'File checkpoint requires an attested workspace-isolating boundary driver; configure the container boundary and run belay session start.',
      )
    }
    if (loadedConfig.capability || boundaryDriver === 'container') {
      const attestationPath = boundaryAttestationPath(repoRoot, loadedConfig)
      const attestationFormat = await inspectBoundaryAttestationFile(attestationPath)
      if (attestationFormat === 'legacy') {
        warnings.push(
          'Boundary attestation uses an unsigned legacy format. Run belay session start to re-sign it.',
        )
      } else if (attestationFormat === 'invalid') {
        warnings.push(
          'Boundary attestation file is present but invalid. Run belay session start to regenerate it.',
        )
      }
    }
    if (boundaryDriver === 'container') {
      const session = await boundarySessionStatus({ repoRoot, config: loadedConfig })
      if (!session.attestation) {
        warnings.push(
          'Container boundary driver is configured but no attestation was found. Run belay session start.',
        )
      } else if (!session.fresh) {
        warnings.push(
          'Boundary attestation is stale or expired. Run belay session start to refresh.',
        )
      } else if (
        loadedConfig.policy.transactional.fileCheckpoint.enabled &&
        session.attestation.isolatesWorkspaceMounts !== true
      ) {
        warnings.push(
          'File checkpoint is enabled but the fresh boundary attestation does not prove workspace-mount isolation. Run belay session start with a compatible boundary.',
        )
      } else if (session.attestation.probeSignals.includes('repo-mount-ro-default')) {
        notes.push(
          'Container boundary defaults to read-only directory mounts; predicted writes use read-write mounts for the working directory only.',
        )
      } else if (session.attestation.probeSignals.includes('repo-mount-rw')) {
        notes.push(
          'Container boundary mounts the working directory read-write (repo-mount-rw). Policy grants scope widening; paths outside the mount are not container-enforced.',
        )
      }
    }

    if (loadedConfig.egress.enabled) {
      const egress = await egressStatus({ targetDir: repoRoot })
      notes.push(
        `Egress proxy: enabled — read/mutate action class enforced at proxy layer (listen ${egress.host}:${egress.port}; demoteL3External config is legacy and not applied to shell classifier).`,
      )
      if (!egress.running) {
        warnings.push(
          'Egress is enabled in config but the local proxy is not running. Run belay egress start.',
        )
      } else {
        notes.push(`Egress proxy running (pid ${egress.pid}).`)
        if (egress.foreignProxy) {
          warnings.push(
            `Egress listen port ${egress.host}:${egress.port} is occupied by another proxy${egress.boundRepoRoot ? ` for ${egress.boundRepoRoot}` : ''}. Do not use belay egress env for this repository.`,
          )
        } else if (egress.repoRootMismatch) {
          warnings.push(
            `Egress proxy is bound to ${egress.boundRepoRoot} but this repo is ${repoRoot}. Stop and restart egress for this repository.`,
          )
        }
      }
    }
  }

  const health = await collectHealthSnapshot({ targetDir: repoRoot, adapter: adapterName })
  if (health.containmentPosture !== 'l1-full') {
    warnings.push(
      `Containment posture is ${health.containmentPosture}: ${health.containmentWarnings.join('; ')}`,
    )
  }
  for (const signal of health.additionalRiskSignals) {
    warnings.push(`Additional risk signal: ${signal}`)
  }
  if (health.skillOnly) {
    warnings.push(
      'Skill-only install detected: belay SKILL.md is present but hook floor is missing or incomplete. ' +
        'This is advisory only — enforcement requires hooks. Run `belay config` (or `belay init`) ' +
        'then `belay doctor` to verify the floor.',
    )
    notes.push(`Skill path: ${health.skillPath}`)
  }
  if (health.skillInstalled && !health.commandsInstalled && adapterName === 'cursor') {
    notes.push(
      'Optional: install Cursor slash commands with `belay init --with-skill` for /belay-approve routing.',
    )
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
    configProvenance,
    dogfood,
  }
  return report
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `belay doctor for ${report.repoRoot}`,
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
