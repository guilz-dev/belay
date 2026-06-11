#!/usr/bin/env node
import process from 'node:process';
import { doctorProject, formatDoctorReport } from './doctor.js';
import { dogfoodProject, formatDogfoodResult } from './dogfood.js';
import { explainCommand, formatExplainReport } from './explain.js';
import { initProject, upgradeProject } from './installer.js';
import { formatMetricsReport, metricsProject } from './metrics.js';
import { revokeApproval } from './revoke.js';
import { formatStatusReport, statusProject } from './status.js';
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
        if (token === '--json') {
            options.json = true;
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
        if (token === '--kind') {
            const next = rest[index + 1];
            if (!next || !['shell', 'tool', 'subagent'].includes(next)) {
                throw new Error('--kind requires shell, tool, or subagent.');
            }
            options.explainKind = next;
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
        if (command === 'revoke' && !options.approvalId) {
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
  agent-belay init [--target <dir>] [--adapter cursor|claude] [--with-skill] [--dogfood]
  agent-belay upgrade [--target <dir>] [--adapter cursor|claude] [--with-skill]
  agent-belay dogfood [--target <dir>] [--adapter cursor|claude] [--enforce] [--force] [--no-spike]
  agent-belay doctor [--target <dir>] [--adapter cursor|claude] [--json] [--fix] [--dry-run]
  agent-belay metrics [--target <dir>] [--json]
  agent-belay status [--target <dir>] [--json]
  agent-belay explain [--target <dir>] [--cwd <dir>] [--kind shell|tool|subagent] [--tool <name>] [--payload-json <json>] [--json] -- <command>
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
