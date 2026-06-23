#!/usr/bin/env node
import process from 'node:process'

import { CLI_COMMAND } from './branding.js'
import { approvePending } from './commands/approve.js'
import { auditProject, formatAuditReport } from './commands/audit.js'
import { doctorProject, formatDoctorReport } from './commands/doctor.js'
import { dogfoodProject, formatDogfoodResult } from './commands/dogfood.js'
import { explainCommand, formatExplainReport } from './commands/explain.js'
import { formatMetricsReport, metricsProject } from './commands/metrics.js'
import { formatRecoverReport, recoverProject } from './commands/recover.js'
import { formatReport, reportProject } from './commands/report.js'
import { revokeApproval } from './commands/revoke.js'
import { formatSimulateReport, simulateProject } from './commands/simulate.js'
import { formatStatusReport, statusProject } from './commands/status.js'
import { loadConfigFile } from './config-io.js'
import { rejectDeprecatedJudgeModelAuto } from './core/judge-model-policy.js'
import { initProject, upgradeProject } from './installer.js'
import type { ConfigPresetName } from './presets.js'
import {
  egressEnv,
  egressStatus,
  formatEgressStatusReport,
  startEgressProxy,
  stopEgressProxy,
} from './services/egress-service.js'
import { formatSandboxStatusReport, sandboxStatus } from './services/sandbox-service.js'
import { PACKAGE_VERSION } from './version.js'

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv
  const options: {
    targetDir?: string
    withSkill?: boolean
    json?: boolean
    approvalId?: string
    explainCommand?: string
    recoverCommand?: string
    explainCwd?: string
    explainKind?: 'shell' | 'tool' | 'subagent'
    explainToolName?: string
    explainPayload?: Record<string, unknown>
    fix?: boolean
    dryRun?: boolean
    dogfood?: boolean
    enforce?: boolean
    force?: boolean
    adapter?: 'cursor' | 'claude' | 'codex'
    auditSubcommand?: 'query' | 'summarize' | 'replay'
    since?: string
    until?: string
    verdict?: string
    reason?: string
    kind?: string
    fingerprint?: string
    event?: string
    location?: string
    opacity?: string
    effect?: string
    confidence?: string
    limit?: number
    configPath?: string
    approvalToken?: string
    egressSubcommand?: 'start' | 'stop' | 'status' | 'env'
    approveScope?: 'once' | 'domain' | 'path' | 'workspace-root'
    approvePath?: string
    approveReplay?: boolean
    sandboxSubcommand?: 'status'
    installScope?: 'project' | 'global'
    preset?: ConfigPresetName
    judgeProfile?: 'local-ollama' | 'cursor' | 'claude' | 'codex'
    judgeProvider?: 'ollama' | 'openai-compatible' | 'cursor'
    judgeModel?: string
    judgeEndpoint?: string
    acceptCloudJudge?: boolean
    migrateJudgeDefault?: boolean
    judgeSubcommand?: 'status' | 'list' | 'use' | 'test' | 'bench' | 'consent'
    judgeLiveProbe?: boolean
    judgeUseProvider?: string
    acceptCloud?: boolean
    cloudConsentApprovalId?: string
    credentialMode?: 'project' | 'apiKey'
    keyStdin?: boolean
    keyEnv?: string
    judgeTimeoutMs?: number
    configSubcommand?: 'list' | 'get' | 'set' | 'unset' | 'credential' | 'judge'
    configKey?: string
    configValue?: string
    credentialAction?: 'mode' | 'set' | 'clear'
  } = {}

  if (!command || command === '--help' || command === '-h') {
    return { command: 'help', options }
  }
  if (command === '--version' || command === '-V') {
    return { command: 'version', options }
  }

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token === '--with-skill') {
      options.withSkill = true
      continue
    }
    if (token === '--dogfood') {
      options.dogfood = true
      continue
    }
    if (token === '--enforce') {
      options.enforce = true
      continue
    }
    if (token === '--force') {
      options.force = true
      continue
    }
    if (token === '--adapter') {
      const next = rest[index + 1]
      if (!next || !['cursor', 'claude', 'codex'].includes(next)) {
        throw new Error('--adapter requires cursor, claude, or codex.')
      }
      options.adapter = next as 'cursor' | 'claude' | 'codex'
      index += 1
      continue
    }
    if (token === '--preset') {
      const next = rest[index + 1]
      const allowed = ['strict', 'standard', 'audit-first', 'l1-full-recommended'] as const
      if (!next || !allowed.includes(next as (typeof allowed)[number])) {
        throw new Error('--preset requires strict, standard, audit-first, or l1-full-recommended.')
      }
      options.preset = next as ConfigPresetName
      index += 1
      continue
    }
    if (token === '--judge-profile') {
      process.stderr.write(
        'Warning: --judge-profile is deprecated; use belay config set judge.providerId <id> after init.\n',
      )
      const next = rest[index + 1]
      if (!next || !['local-ollama', 'cursor', 'claude', 'codex'].includes(next)) {
        throw new Error('--judge-profile requires local-ollama, cursor, claude, or codex.')
      }
      options.judgeProfile = next as 'local-ollama' | 'cursor' | 'claude' | 'codex'
      index += 1
      continue
    }
    if (token === '--judge-provider') {
      const next = rest[index + 1]
      if (!next || !['ollama', 'openai-compatible', 'cursor'].includes(next)) {
        throw new Error('--judge-provider requires ollama or openai-compatible.')
      }
      options.judgeProvider = next as 'ollama' | 'openai-compatible' | 'cursor'
      index += 1
      continue
    }
    if (token === '--judge-endpoint') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--judge-endpoint requires a URL.')
      }
      options.judgeEndpoint = next
      index += 1
      continue
    }
    if (token === '--judge-model') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--judge-model requires a model id.')
      }
      rejectDeprecatedJudgeModelAuto(next)
      options.judgeModel = next
      index += 1
      continue
    }
    if (token === '--accept-cloud-judge') {
      options.acceptCloudJudge = true
      continue
    }
    if (token === '--migrate-judge-default') {
      options.migrateJudgeDefault = true
      continue
    }
    if (token === '--accept-cloud') {
      options.acceptCloud = true
      continue
    }
    if (token === '--cloud-consent-approval-id') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--cloud-consent-approval-id requires an approval id.')
      }
      options.cloudConsentApprovalId = next
      index += 1
      continue
    }
    if (token === '--credential') {
      const next = rest[index + 1]
      if (!next || !['project', 'apiKey'].includes(next)) {
        throw new Error('--credential requires project or apiKey.')
      }
      options.credentialMode = next as 'project' | 'apiKey'
      index += 1
      continue
    }
    if (token === '--key-stdin') {
      options.keyStdin = true
      continue
    }
    if (token === '--key-env') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--key-env requires an environment variable name.')
      }
      options.keyEnv = next
      index += 1
      continue
    }
    if (token === '--timeout') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--timeout requires milliseconds.')
      }
      options.judgeTimeoutMs = Number(next)
      index += 1
      continue
    }
    if (token === '--live-probe') {
      if (command !== 'judge') {
        throw new Error('--live-probe is only valid for judge test.')
      }
      options.judgeLiveProbe = true
      continue
    }
    if (token === '--json') {
      options.json = true
      continue
    }
    if (token === '--since') {
      options.since = rest[index + 1]
      index += 1
      continue
    }
    if (token === '--until') {
      options.until = rest[index + 1]
      index += 1
      continue
    }
    if (token === '--verdict') {
      options.verdict = rest[index + 1]
      index += 1
      continue
    }
    if (token === '--reason') {
      options.reason = rest[index + 1]
      index += 1
      continue
    }
    if (token === '--kind') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--kind requires a value.')
      }
      if (command === 'audit') {
        options.kind = next
      } else {
        if (!['shell', 'tool', 'subagent'].includes(next)) {
          throw new Error('--kind requires shell, tool, or subagent.')
        }
        options.explainKind = next as 'shell' | 'tool' | 'subagent'
      }
      index += 1
      continue
    }
    if (token === '--fingerprint') {
      options.fingerprint = rest[index + 1]
      index += 1
      continue
    }
    if (token === '--event') {
      options.event = rest[index + 1]
      index += 1
      continue
    }
    if (token === '--location') {
      options.location = rest[index + 1]
      index += 1
      continue
    }
    if (token === '--opacity') {
      options.opacity = rest[index + 1]
      index += 1
      continue
    }
    if (token === '--effect') {
      options.effect = rest[index + 1]
      index += 1
      continue
    }
    if (token === '--confidence') {
      options.confidence = rest[index + 1]
      index += 1
      continue
    }
    if (token === '--limit') {
      const next = Number(rest[index + 1])
      if (!Number.isFinite(next)) {
        throw new Error('--limit requires a number.')
      }
      options.limit = next
      index += 1
      continue
    }
    if (token === '--config') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--config requires a path.')
      }
      options.configPath = next
      index += 1
      continue
    }
    if (token === '--token') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--token requires a signed approval token.')
      }
      options.approvalToken = next
      index += 1
      continue
    }
    if (token === '--replay') {
      if (command !== 'approve') {
        throw new Error('--replay is only valid for approve.')
      }
      options.approveReplay = true
      continue
    }
    if (token === '--scope') {
      const next = rest[index + 1]
      if (command === 'approve') {
        if (!next || !['once', 'domain', 'path', 'workspace-root'].includes(next)) {
          throw new Error('--scope requires once, domain, path, or workspace-root.')
        }
        options.approveScope = next as 'once' | 'domain' | 'path' | 'workspace-root'
      } else if (command === 'init' || command === 'upgrade') {
        if (!next || !['project', 'global'].includes(next)) {
          throw new Error('--scope requires project or global.')
        }
        options.installScope = next as 'project' | 'global'
      } else {
        throw new Error('--scope is only valid for init, upgrade, or approve.')
      }
      index += 1
      continue
    }
    if (token === '--path') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--path requires a filesystem path.')
      }
      options.approvePath = next
      index += 1
      continue
    }
    if (token === '--fix') {
      options.fix = true
      continue
    }
    if (token === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (token === '--target') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--target requires a path value.')
      }
      options.targetDir = next
      index += 1
      continue
    }
    if (token === '--cwd') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--cwd requires a path value.')
      }
      options.explainCwd = next
      index += 1
      continue
    }
    if (token === '--command') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--command requires a value.')
      }
      if (command === 'recover') {
        options.recoverCommand = next
      } else {
        options.explainCommand = next
      }
      index += 1
      continue
    }
    if (token === '--tool') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--tool requires a tool name.')
      }
      options.explainToolName = next
      index += 1
      continue
    }
    if (token === '--payload-json') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--payload-json requires a JSON object.')
      }
      options.explainPayload = JSON.parse(next) as Record<string, unknown>
      index += 1
      continue
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help', options }
    }
    if (token === '--') {
      options.explainCommand = rest.slice(index + 1).join(' ')
      break
    }
    if (command === 'audit' && !options.auditSubcommand) {
      if (token === 'query' || token === 'summarize' || token === 'replay') {
        options.auditSubcommand = token
        continue
      }
      throw new Error('audit requires subcommand: query, summarize, or replay')
    }
    if (command === 'egress' && !options.egressSubcommand) {
      if (token === 'start' || token === 'stop' || token === 'status' || token === 'env') {
        options.egressSubcommand = token
        continue
      }
      throw new Error('egress requires subcommand: start, stop, status, or env')
    }
    if (command === 'sandbox' && !options.sandboxSubcommand) {
      if (token === 'status') {
        options.sandboxSubcommand = token
        continue
      }
      throw new Error('sandbox requires subcommand: status')
    }
    if (command === 'judge' && !options.judgeSubcommand) {
      if (
        token === 'status' ||
        token === 'list' ||
        token === 'use' ||
        token === 'test' ||
        token === 'bench' ||
        token === 'consent'
      ) {
        options.judgeSubcommand = token
        continue
      }
      throw new Error('judge requires subcommand: status, list, use, test, bench, or consent')
    }
    if (command === 'config' && !options.configSubcommand) {
      if (
        token === 'list' ||
        token === 'get' ||
        token === 'set' ||
        token === 'unset' ||
        token === 'credential' ||
        token === 'judge'
      ) {
        options.configSubcommand = token
        continue
      }
      throw new Error('config requires subcommand: list, get, set, unset, credential, or judge')
    }
    if (
      command === 'config' &&
      options.configSubcommand === 'credential' &&
      !options.credentialAction
    ) {
      if (token === 'mode' || token === 'set' || token === 'clear') {
        options.credentialAction = token
        continue
      }
      throw new Error('config credential requires action: mode, set, or clear')
    }
    if (
      command === 'config' &&
      options.configSubcommand === 'credential' &&
      options.credentialAction === 'mode' &&
      !options.credentialMode
    ) {
      if (token === 'project' || token === 'apiKey') {
        options.credentialMode = token
        continue
      }
      throw new Error('config credential mode requires project or apiKey')
    }
    if (
      command === 'config' &&
      (options.configSubcommand === 'get' ||
        options.configSubcommand === 'set' ||
        options.configSubcommand === 'unset') &&
      !options.configKey
    ) {
      options.configKey = token
      continue
    }
    if (
      command === 'config' &&
      options.configSubcommand === 'set' &&
      options.configKey &&
      !options.configValue
    ) {
      options.configValue = token
      continue
    }
    if (
      command === 'judge' &&
      (options.judgeSubcommand === 'use' || options.judgeSubcommand === 'consent') &&
      !options.judgeUseProvider
    ) {
      options.judgeUseProvider = token
      continue
    }
    if ((command === 'revoke' || command === 'approve') && !options.approvalId) {
      options.approvalId = token
      continue
    }
    throw new Error(`Unknown argument: ${token}`)
  }

  return { command: command ?? 'help', options }
}

function printHelp() {
  const c = CLI_COMMAND
  process.stdout.write(`${c}

Usage:
  ${c} init [--target <dir>] [--adapter cursor|claude|codex] [--scope project|global] [--preset strict|standard|audit-first|l1-full-recommended] [--judge-profile local-ollama|cursor|claude|codex] [--judge-provider ollama|openai-compatible] [--judge-model <id>] [--judge-endpoint <url>] [--accept-cloud-judge] [--migrate-judge-default] [--with-skill] [--dogfood]
  ${c} config [--target <dir>] [--json]
  ${c} config list|get|set|unset|judge [--target <dir>] [--json]
  ${c} config get <judge.path> [--target <dir>] [--json]
  ${c} config set <judge.path> <value> [--target <dir>]
  ${c} config unset <judge.path> [--target <dir>]
  ${c} config credential mode <project|apiKey> [--target <dir>]
  ${c} config credential set [--key-stdin] [--key-env <NAME>] [--target <dir>]
  ${c} config credential clear [--target <dir>]
  (--adapter selects host; fresh init picks matching judge providerId: cursor/claude/codex)
  (--dogfood runs after --preset and sets mode: audit, overriding preset enforce mode)
  ${c} upgrade [--target <dir>] [--adapter cursor|claude|codex] [--scope project|global] [--with-skill] [--migrate-judge-default]
  ${c} dogfood [--target <dir>] [--adapter cursor|claude|codex] [--enforce] [--force]
  ${c} doctor [--target <dir>] [--adapter cursor|claude|codex] [--json] [--fix] [--dry-run]
  ${c} metrics [--target <dir>] [--json]
  ${c} report [--target <dir>] [--since <iso>] [--until <iso>] [--limit <n>] [--json]
  ${c} recover [--target <dir>] [--since <iso>] [--fingerprint <fp>] [--command "<text>"] [--limit <n>] [--json]
    (--limit picks the Nth recover candidate after priority ranking: local_mutation first, then recency; 1 = highest priority, default 1)
  ${c} audit <query|summarize|replay> [--target <dir>] [--json] [--since <iso>] [--until <iso>] [--verdict <v>] [--reason <r>] [--kind <k>] [--fingerprint <fp>] [--event <e>] [--location <v>] [--opacity <v>] [--effect <v>] [--confidence <v>] [--limit <n>] [--config <path>]
  ${c} simulate --config <path> [--target <dir>] [--json]
  ${c} status [--target <dir>] [--json]
  ${c} explain [--target <dir>] [--cwd <dir>] [--kind shell|tool|subagent] [--tool <name>] [--payload-json <json>] [--command <text>] [--json] [-- <command>]
  ${c} egress <start|stop|status|env> [--target <dir>] [--json]
  ${c} sandbox status [--target <dir>] [--json]
  ${c} judge <status|list|use|test|bench|consent> [--target <dir>] [--json]
  ${c} judge test [--target <dir>] [--json] [--live-probe]
  ${c} judge use <ollama|codex|claude|cursor> [--model <id>] [--endpoint <url>] [--timeout <ms>] [--accept-cloud] [--cloud-consent-approval-id <id>] [--credential project|apiKey] [--key-stdin] [--key-env <NAME>]
  ${c} judge consent <ollama|codex|claude|cursor> [--endpoint <url>]
  ${c} approve <approval-id> [--replay] [--scope once|domain|path|workspace-root] [--path <path>] [--token <signed-token>] [--target <dir>]
  ${c} revoke <approval-id> [--target <dir>]
`)
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2))
    if (command === 'help') {
      printHelp()
      return
    }

    if (command === 'version') {
      process.stdout.write(`${PACKAGE_VERSION}\n`)
      return
    }

    const DEPRECATED_COMMANDS = new Set(['init-wizard'])
    if (DEPRECATED_COMMANDS.has(command)) {
      process.stderr.write(
        `${command} is removed. Use \`belay config\` for interactive setup, or \`belay init\` for non-interactive install.\n`,
      )
      process.exitCode = 1
      return
    }

    if (command === 'init') {
      const result = await initProject({
        targetDir: options.targetDir,
        withSkill: options.withSkill,
        dogfood: options.dogfood,
        adapter: options.adapter,
        scope: options.installScope,
        preset: options.preset,
        judgeProfile: options.judgeProfile,
        judgeProvider: options.judgeProvider,
        judgeModel: options.judgeModel,
        judgeEndpoint: options.judgeEndpoint,
        acceptCloudJudge: options.acceptCloudJudge,
        migrateJudgeDefault: options.migrateJudgeDefault,
      })
      const extras = [
        `adapter=${result.adapter}`,
        result.withSkill ? 'skill extras enabled' : null,
        result.dogfood ? 'dogfood mode enabled' : null,
      ].filter(Boolean)
      process.stdout.write(`Initialized belay in ${result.repoRoot} (${extras.join(', ')}).\n`)
      return
    }

    if (command === 'dogfood') {
      const result = await dogfoodProject({
        targetDir: options.targetDir,
        enforce: options.enforce,
        force: options.force,
        adapter: options.adapter,
      })
      process.stdout.write(formatDogfoodResult(result))
      process.exitCode = result.ok ? 0 : 1
      return
    }

    if (command === 'upgrade') {
      const result = await upgradeProject({
        targetDir: options.targetDir,
        withSkill: options.withSkill,
        adapter: options.adapter,
        scope: options.installScope,
        migrateJudgeDefault: options.migrateJudgeDefault,
      })
      const upgraded = await loadConfigFile(result.repoRoot, result.adapter)
      if (upgraded.policy.modelAssist.enabled) {
        process.stderr.write(
          'Warning: policy.modelAssist is enabled but is not wired to v2 Tier1. Use top-level judge instead.\n',
        )
      }
      process.stdout.write(`Upgraded belay (${result.adapter}) in ${result.repoRoot}.\n`)
      return
    }

    if (command === 'judge') {
      const { runJudgeCommand } = await import('./commands/judge.js')
      if (!options.judgeSubcommand) {
        throw new Error('judge requires subcommand: status, list, use, or test')
      }
      if (options.judgeLiveProbe && options.judgeSubcommand !== 'test') {
        throw new Error('--live-probe is only valid for judge test.')
      }
      const result = await runJudgeCommand({
        targetDir: options.targetDir,
        json: options.json,
        subcommand: options.judgeSubcommand,
        providerId: options.judgeUseProvider,
        model: options.judgeModel,
        endpoint: options.judgeEndpoint,
        timeoutMs: options.judgeTimeoutMs,
        acceptCloud: options.acceptCloud,
        cloudConsentApprovalId: options.cloudConsentApprovalId,
        credentialMode: options.credentialMode,
        keyStdin: options.keyStdin,
        keyEnv: options.keyEnv,
        liveProbe: options.judgeLiveProbe,
      })
      if (options.json && typeof result === 'object') {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      } else {
        process.stdout.write(`${String(result)}\n`)
      }
      return
    }

    if (command === 'config') {
      if (options.configSubcommand === 'credential') {
        if (!options.credentialAction) {
          throw new Error('config credential requires action: mode, set, or clear')
        }
        const { runBelayConfigCredential } = await import('./commands/config.js')
        const result = await runBelayConfigCredential({
          targetDir: options.targetDir,
          action: options.credentialAction,
          mode: options.credentialMode,
          keyStdin: options.keyStdin,
          keyEnv: options.keyEnv,
        })
        process.stdout.write(`${String(result)}\n`)
        return
      }
      const { runBelayConfig } = await import('./commands/config.js')
      const result = await runBelayConfig({
        targetDir: options.targetDir,
        subcommand: options.configSubcommand,
        path: options.configKey,
        value: options.configValue,
        json: options.json,
      })
      if (options.json && typeof result === 'object') {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      } else if (typeof result === 'object' && result && 'repoRoot' in result) {
        const initResult = result as { repoRoot: string; withSkill?: boolean }
        process.stdout.write(
          `Initialized belay in ${initResult.repoRoot}${initResult.withSkill ? ' (with skill)' : ''}.\n`,
        )
      } else {
        process.stdout.write(`${String(result)}\n`)
      }
      return
    }

    if (command === 'doctor') {
      const report = await doctorProject({
        targetDir: options.targetDir,
        fix: options.fix,
        dryRun: options.dryRun,
        adapter: options.adapter,
      })
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(formatDoctorReport(report))
      }
      process.exitCode = report.ok ? 0 : 1
      return
    }

    if (command === 'audit') {
      if (!options.auditSubcommand) {
        throw new Error('audit requires subcommand: query, summarize, or replay')
      }
      const report = await auditProject({
        targetDir: options.targetDir,
        subcommand: options.auditSubcommand,
        json: options.json,
        since: options.since,
        until: options.until,
        verdict: options.verdict,
        reason: options.reason,
        kind: options.kind,
        fingerprint: options.fingerprint,
        event: options.event,
        location: options.location,
        opacity: options.opacity,
        effect: options.effect,
        confidence: options.confidence,
        limit: options.limit,
        configPath: options.configPath,
      })
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(formatAuditReport(report))
      }
      return
    }

    if (command === 'simulate') {
      if (!options.configPath) {
        throw new Error('simulate requires --config <path>.')
      }
      const report = await simulateProject({
        targetDir: options.targetDir,
        configPath: options.configPath,
        json: options.json,
      })
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(formatSimulateReport(report))
      }
      return
    }

    if (command === 'metrics') {
      const report = await metricsProject({
        targetDir: options.targetDir,
        json: options.json,
      })
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(formatMetricsReport(report))
      }
      return
    }

    if (command === 'report') {
      const report = await reportProject({
        targetDir: options.targetDir,
        since: options.since,
        until: options.until,
        limit: options.limit,
        json: options.json,
      })
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(formatReport(report))
      }
      return
    }

    if (command === 'recover') {
      const report = await recoverProject({
        targetDir: options.targetDir,
        since: options.since,
        fingerprint: options.fingerprint,
        command: options.recoverCommand,
        limit: options.limit,
        json: options.json,
      })
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(formatRecoverReport(report))
      }
      return
    }

    if (command === 'status') {
      const report = await statusProject({
        targetDir: options.targetDir,
        json: options.json,
      })
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(formatStatusReport(report))
      }
      return
    }

    if (command === 'explain') {
      const report = await explainCommand({
        targetDir: options.targetDir,
        command: options.explainCommand,
        cwd: options.explainCwd,
        json: options.json,
        kind: options.explainKind,
        toolName: options.explainToolName,
        payload: options.explainPayload,
        explainLastPending: !options.explainCommand && !options.explainPayload,
      })
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(formatExplainReport(report))
      }
      return
    }

    if (command === 'egress') {
      if (!options.egressSubcommand) {
        throw new Error('egress requires subcommand: start, stop, status, or env')
      }
      if (options.egressSubcommand === 'start') {
        const result = await startEgressProxy({ targetDir: options.targetDir })
        process.stdout.write(`${result.message}\n`)
        process.exitCode = result.ok ? 0 : 1
        return
      }
      if (options.egressSubcommand === 'stop') {
        const result = await stopEgressProxy({ targetDir: options.targetDir })
        process.stdout.write(`${result.message}\n`)
        process.exitCode = result.ok ? 0 : 1
        return
      }
      if (options.egressSubcommand === 'env') {
        const result = await egressEnv({ targetDir: options.targetDir })
        if (options.json) {
          process.stdout.write(`${JSON.stringify({ ok: result.ok, env: result.env }, null, 2)}\n`)
        } else {
          process.stdout.write(`${result.message}\n`)
        }
        process.exitCode = result.ok ? 0 : 1
        return
      }
      const report = await egressStatus({ targetDir: options.targetDir })
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(formatEgressStatusReport(report))
      }
      return
    }

    if (command === 'sandbox') {
      if (!options.sandboxSubcommand) {
        throw new Error('sandbox requires subcommand: status')
      }
      const report = await sandboxStatus({ targetDir: options.targetDir })
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(formatSandboxStatusReport(report))
      }
      process.exitCode = report.issues.length > 0 && report.sandboxEnabled ? 1 : 0
      return
    }

    if (command === 'approve') {
      if (!options.approvalId) {
        throw new Error('approve requires an approval ID.')
      }
      const result = await approvePending({
        targetDir: options.targetDir,
        approvalId: options.approvalId,
        token: options.approvalToken,
        scope: options.approveScope,
        scopePath: options.approvePath,
        replay: options.approveReplay,
      })
      process.stdout.write(`${result.message}\n`)
      process.exitCode = result.ok ? 0 : 1
      return
    }

    if (command === 'revoke') {
      if (!options.approvalId) {
        throw new Error('revoke requires an approval ID.')
      }
      const result = await revokeApproval({
        targetDir: options.targetDir,
        approvalId: options.approvalId,
      })
      process.stdout.write(`${result.message}\n`)
      process.exitCode = result.ok ? 0 : 1
      return
    }

    throw new Error(`Unknown command: ${command}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}

await main()
