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
    approveScope?: 'once' | 'domain' | 'path'
    approvePath?: string
    sandboxSubcommand?: 'status'
    installScope?: 'project' | 'global'
    preset?: ConfigPresetName
    judgeProfile?: 'local-ollama' | 'cursor' | 'claude' | 'codex'
    judgeProvider?: 'ollama' | 'openai-compatible' | 'cursor'
    judgeModel?: string
    judgeEndpoint?: string
    acceptCloudJudge?: boolean
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
        throw new Error('--judge-model requires a model id or auto.')
      }
      options.judgeModel = next
      index += 1
      continue
    }
    if (token === '--accept-cloud-judge') {
      options.acceptCloudJudge = true
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
    if (token === '--scope') {
      const next = rest[index + 1]
      if (command === 'approve') {
        if (!next || !['once', 'domain', 'path'].includes(next)) {
          throw new Error('--scope requires once, domain, or path.')
        }
        options.approveScope = next as 'once' | 'domain' | 'path'
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
  ${c} init [--target <dir>] [--adapter cursor|claude|codex] [--scope project|global] [--preset strict|standard|audit-first|l1-full-recommended] [--judge-profile local-ollama|cursor|claude|codex] [--judge-provider ollama|openai-compatible] [--judge-model <id|auto>] [--judge-endpoint <url>] [--accept-cloud-judge] [--with-skill] [--dogfood]
  ${c} init-wizard [--target <dir>]
  (--dogfood runs after --preset and sets mode: audit, overriding preset enforce mode)
  ${c} upgrade [--target <dir>] [--adapter cursor|claude|codex] [--scope project|global] [--with-skill]
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
  ${c} approve <approval-id> [--scope once|domain|path] [--path <path>] [--token <signed-token>] [--target <dir>]
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

    if (command === 'init-wizard') {
      const { runInitWizard } = await import('./commands/init-wizard.js')
      const result = await runInitWizard({ targetDir: options.targetDir })
      process.stdout.write(
        `Initialized belay in ${result.repoRoot}${result.withSkill ? ' (with skill)' : ''}.\n`,
      )
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
