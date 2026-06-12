#!/usr/bin/env node
import process from 'node:process';
import { approvePending } from './commands/approve.js';
import { auditProject, formatAuditReport } from './commands/audit.js';
import { doctorProject, formatDoctorReport } from './commands/doctor.js';
import { dogfoodProject, formatDogfoodResult } from './commands/dogfood.js';
import { explainCommand, formatExplainReport } from './commands/explain.js';
import { formatMetricsReport, metricsProject } from './commands/metrics.js';
import { revokeApproval } from './commands/revoke.js';
import { formatSimulateReport, simulateProject } from './commands/simulate.js';
import { formatStatusReport, statusProject } from './commands/status.js';
import { initProject, upgradeProject } from './installer.js';
import { egressEnv, egressStatus, formatEgressStatusReport, startEgressProxy, stopEgressProxy, } from './services/egress-service.js';
import { formatSandboxStatusReport, sandboxStatus } from './services/sandbox-service.js';
function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (token === '--with-skill') {
            options.withSkill = true;
            continue;
        }
        if (token === '--dogfood') {
            options.dogfood = true;
            continue;
        }
        if (token === '--enforce') {
            options.enforce = true;
            continue;
        }
        if (token === '--force') {
            options.force = true;
            continue;
        }
        if (token === '--no-spike') {
            options.noSpike = true;
            continue;
        }
        if (token === '--adapter') {
            const next = rest[index + 1];
            if (!next || !['cursor', 'claude'].includes(next)) {
                throw new Error('--adapter requires cursor or claude.');
            }
            options.adapter = next;
            index += 1;
            continue;
        }
        if (token === '--preset') {
            const next = rest[index + 1];
            const allowed = ['strict', 'standard', 'audit-first', 'l1-full-recommended'];
            if (!next || !allowed.includes(next)) {
                throw new Error('--preset requires strict, standard, audit-first, or l1-full-recommended.');
            }
            options.preset = next;
            index += 1;
            continue;
        }
        if (token === '--json') {
            options.json = true;
            continue;
        }
        if (token === '--since') {
            options.since = rest[index + 1];
            index += 1;
            continue;
        }
        if (token === '--until') {
            options.until = rest[index + 1];
            index += 1;
            continue;
        }
        if (token === '--verdict') {
            options.verdict = rest[index + 1];
            index += 1;
            continue;
        }
        if (token === '--reason') {
            options.reason = rest[index + 1];
            index += 1;
            continue;
        }
        if (token === '--kind') {
            const next = rest[index + 1];
            if (!next) {
                throw new Error('--kind requires a value.');
            }
            if (command === 'audit') {
                options.kind = next;
            }
            else {
                if (!['shell', 'tool', 'subagent'].includes(next)) {
                    throw new Error('--kind requires shell, tool, or subagent.');
                }
                options.explainKind = next;
            }
            index += 1;
            continue;
        }
        if (token === '--fingerprint') {
            options.fingerprint = rest[index + 1];
            index += 1;
            continue;
        }
        if (token === '--event') {
            options.event = rest[index + 1];
            index += 1;
            continue;
        }
        if (token === '--location') {
            options.location = rest[index + 1];
            index += 1;
            continue;
        }
        if (token === '--opacity') {
            options.opacity = rest[index + 1];
            index += 1;
            continue;
        }
        if (token === '--effect') {
            options.effect = rest[index + 1];
            index += 1;
            continue;
        }
        if (token === '--confidence') {
            options.confidence = rest[index + 1];
            index += 1;
            continue;
        }
        if (token === '--limit') {
            const next = Number(rest[index + 1]);
            if (!Number.isFinite(next)) {
                throw new Error('--limit requires a number.');
            }
            options.limit = next;
            index += 1;
            continue;
        }
        if (token === '--config') {
            const next = rest[index + 1];
            if (!next) {
                throw new Error('--config requires a path.');
            }
            options.configPath = next;
            index += 1;
            continue;
        }
        if (token === '--token') {
            const next = rest[index + 1];
            if (!next) {
                throw new Error('--token requires a signed approval token.');
            }
            options.approvalToken = next;
            index += 1;
            continue;
        }
        if (token === '--scope') {
            const next = rest[index + 1];
            if (!next || !['once', 'domain', 'path'].includes(next)) {
                throw new Error('--scope requires once, domain, or path.');
            }
            options.approveScope = next;
            index += 1;
            continue;
        }
        if (token === '--path') {
            const next = rest[index + 1];
            if (!next) {
                throw new Error('--path requires a filesystem path.');
            }
            options.approvePath = next;
            index += 1;
            continue;
        }
        if (token === '--fix') {
            options.fix = true;
            continue;
        }
        if (token === '--dry-run') {
            options.dryRun = true;
            continue;
        }
        if (token === '--target') {
            const next = rest[index + 1];
            if (!next) {
                throw new Error('--target requires a path value.');
            }
            options.targetDir = next;
            index += 1;
            continue;
        }
        if (token === '--cwd') {
            const next = rest[index + 1];
            if (!next) {
                throw new Error('--cwd requires a path value.');
            }
            options.explainCwd = next;
            index += 1;
            continue;
        }
        if (token === '--tool') {
            const next = rest[index + 1];
            if (!next) {
                throw new Error('--tool requires a tool name.');
            }
            options.explainToolName = next;
            index += 1;
            continue;
        }
        if (token === '--payload-json') {
            const next = rest[index + 1];
            if (!next) {
                throw new Error('--payload-json requires a JSON object.');
            }
            options.explainPayload = JSON.parse(next);
            index += 1;
            continue;
        }
        if (token === '--help' || token === '-h') {
            return { command: 'help', options };
        }
        if (token === '--') {
            options.explainCommand = rest.slice(index + 1).join(' ');
            break;
        }
        if (command === 'audit' && !options.auditSubcommand) {
            if (token === 'query' || token === 'summarize' || token === 'replay') {
                options.auditSubcommand = token;
                continue;
            }
            throw new Error('audit requires subcommand: query, summarize, or replay');
        }
        if (command === 'egress' && !options.egressSubcommand) {
            if (token === 'start' || token === 'stop' || token === 'status' || token === 'env') {
                options.egressSubcommand = token;
                continue;
            }
            throw new Error('egress requires subcommand: start, stop, status, or env');
        }
        if (command === 'sandbox' && !options.sandboxSubcommand) {
            if (token === 'status') {
                options.sandboxSubcommand = token;
                continue;
            }
            throw new Error('sandbox requires subcommand: status');
        }
        if ((command === 'revoke' || command === 'approve') && !options.approvalId) {
            options.approvalId = token;
            continue;
        }
        throw new Error(`Unknown argument: ${token}`);
    }
    return { command: command ?? 'help', options };
}
function printHelp() {
    process.stdout.write(`agent-belay

Usage:
  agent-belay init [--target <dir>] [--adapter cursor|claude] [--preset strict|standard|audit-first|l1-full-recommended] [--with-skill] [--dogfood]
    (--dogfood runs after --preset and sets mode: audit, overriding preset enforce mode)
  agent-belay upgrade [--target <dir>] [--adapter cursor|claude] [--with-skill]
  agent-belay dogfood [--target <dir>] [--adapter cursor|claude] [--enforce] [--force] [--no-spike]
  agent-belay doctor [--target <dir>] [--adapter cursor|claude] [--json] [--fix] [--dry-run]
  agent-belay metrics [--target <dir>] [--json]
  agent-belay audit <query|summarize|replay> [--target <dir>] [--json] [--since <iso>] [--until <iso>] [--verdict <v>] [--reason <r>] [--kind <k>] [--fingerprint <fp>] [--event <e>] [--location <v>] [--opacity <v>] [--effect <v>] [--confidence <v>] [--limit <n>] [--config <path>]
  agent-belay simulate --config <path> [--target <dir>] [--json]
  agent-belay status [--target <dir>] [--json]
  agent-belay explain [--target <dir>] [--cwd <dir>] [--kind shell|tool|subagent] [--tool <name>] [--payload-json <json>] [--json] -- <command>
  agent-belay egress <start|stop|status|env> [--target <dir>] [--json]
  agent-belay sandbox status [--target <dir>] [--json]
  agent-belay approve <approval-id> [--scope once|domain|path] [--path <path>] [--token <signed-token>] [--target <dir>]
  agent-belay revoke <approval-id> [--target <dir>]
`);
}
async function main() {
    try {
        const { command, options } = parseArgs(process.argv.slice(2));
        if (command === 'help') {
            printHelp();
            return;
        }
        if (command === 'init') {
            const result = await initProject({
                targetDir: options.targetDir,
                withSkill: options.withSkill,
                dogfood: options.dogfood,
                adapter: options.adapter,
                preset: options.preset,
            });
            const extras = [
                `adapter=${result.adapter}`,
                result.withSkill ? 'skill extras enabled' : null,
                result.dogfood ? 'dogfood mode enabled' : null,
            ].filter(Boolean);
            process.stdout.write(`Initialized agent-belay in ${result.repoRoot} (${extras.join(', ')}).\n`);
            return;
        }
        if (command === 'dogfood') {
            const result = await dogfoodProject({
                targetDir: options.targetDir,
                enforce: options.enforce,
                force: options.force,
                spikeOnPrompt: options.noSpike ? false : undefined,
                adapter: options.adapter,
            });
            process.stdout.write(formatDogfoodResult(result));
            process.exitCode = result.ok ? 0 : 1;
            return;
        }
        if (command === 'upgrade') {
            const result = await upgradeProject({
                targetDir: options.targetDir,
                withSkill: options.withSkill,
                adapter: options.adapter,
            });
            process.stdout.write(`Upgraded agent-belay (${result.adapter}) in ${result.repoRoot}.\n`);
            return;
        }
        if (command === 'doctor') {
            const report = await doctorProject({
                targetDir: options.targetDir,
                fix: options.fix,
                dryRun: options.dryRun,
                adapter: options.adapter,
            });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            }
            else {
                process.stdout.write(formatDoctorReport(report));
            }
            process.exitCode = report.ok ? 0 : 1;
            return;
        }
        if (command === 'audit') {
            if (!options.auditSubcommand) {
                throw new Error('audit requires subcommand: query, summarize, or replay');
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
            });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            }
            else {
                process.stdout.write(formatAuditReport(report));
            }
            return;
        }
        if (command === 'simulate') {
            if (!options.configPath) {
                throw new Error('simulate requires --config <path>.');
            }
            const report = await simulateProject({
                targetDir: options.targetDir,
                configPath: options.configPath,
                json: options.json,
            });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            }
            else {
                process.stdout.write(formatSimulateReport(report));
            }
            return;
        }
        if (command === 'metrics') {
            const report = await metricsProject({
                targetDir: options.targetDir,
                json: options.json,
            });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            }
            else {
                process.stdout.write(formatMetricsReport(report));
            }
            return;
        }
        if (command === 'status') {
            const report = await statusProject({
                targetDir: options.targetDir,
                json: options.json,
            });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            }
            else {
                process.stdout.write(formatStatusReport(report));
            }
            return;
        }
        if (command === 'explain') {
            if (!options.explainCommand && !options.explainPayload) {
                throw new Error('explain requires a command after -- or --payload-json');
            }
            const report = await explainCommand({
                targetDir: options.targetDir,
                command: options.explainCommand,
                cwd: options.explainCwd,
                json: options.json,
                kind: options.explainKind,
                toolName: options.explainToolName,
                payload: options.explainPayload,
            });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            }
            else {
                process.stdout.write(formatExplainReport(report));
            }
            return;
        }
        if (command === 'egress') {
            if (!options.egressSubcommand) {
                throw new Error('egress requires subcommand: start, stop, status, or env');
            }
            if (options.egressSubcommand === 'start') {
                const result = await startEgressProxy({ targetDir: options.targetDir });
                process.stdout.write(`${result.message}\n`);
                process.exitCode = result.ok ? 0 : 1;
                return;
            }
            if (options.egressSubcommand === 'stop') {
                const result = await stopEgressProxy({ targetDir: options.targetDir });
                process.stdout.write(`${result.message}\n`);
                process.exitCode = result.ok ? 0 : 1;
                return;
            }
            if (options.egressSubcommand === 'env') {
                const result = await egressEnv({ targetDir: options.targetDir });
                if (options.json) {
                    process.stdout.write(`${JSON.stringify({ ok: result.ok, env: result.env }, null, 2)}\n`);
                }
                else {
                    process.stdout.write(`${result.message}\n`);
                }
                process.exitCode = result.ok ? 0 : 1;
                return;
            }
            const report = await egressStatus({ targetDir: options.targetDir });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            }
            else {
                process.stdout.write(formatEgressStatusReport(report));
            }
            return;
        }
        if (command === 'sandbox') {
            if (!options.sandboxSubcommand) {
                throw new Error('sandbox requires subcommand: status');
            }
            const report = await sandboxStatus({ targetDir: options.targetDir });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            }
            else {
                process.stdout.write(formatSandboxStatusReport(report));
            }
            process.exitCode = report.issues.length > 0 && report.sandboxEnabled ? 1 : 0;
            return;
        }
        if (command === 'approve') {
            if (!options.approvalId) {
                throw new Error('approve requires an approval ID.');
            }
            const result = await approvePending({
                targetDir: options.targetDir,
                approvalId: options.approvalId,
                token: options.approvalToken,
                scope: options.approveScope,
                scopePath: options.approvePath,
            });
            process.stdout.write(`${result.message}\n`);
            process.exitCode = result.ok ? 0 : 1;
            return;
        }
        if (command === 'revoke') {
            if (!options.approvalId) {
                throw new Error('revoke requires an approval ID.');
            }
            const result = await revokeApproval({
                targetDir: options.targetDir,
                approvalId: options.approvalId,
            });
            process.stdout.write(`${result.message}\n`);
            process.exitCode = result.ok ? 0 : 1;
            return;
        }
        throw new Error(`Unknown command: ${command}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
await main();
