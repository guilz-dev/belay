#!/usr/bin/env node
import process from 'node:process';
import { doctorProject, formatDoctorReport } from './doctor.js';
import { explainCommand, formatExplainReport } from './explain.js';
import { initProject, upgradeProject } from './installer.js';
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
        if (token === '--json') {
            options.json = true;
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
  agent-belay init [--target <dir>] [--with-skill]
  agent-belay upgrade [--target <dir>] [--with-skill]
  agent-belay doctor [--target <dir>] [--json]
  agent-belay status [--target <dir>] [--json]
  agent-belay explain [--target <dir>] [--cwd <dir>] [--json] -- <command>
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
            });
            process.stdout.write(`Initialized agent-belay in ${result.repoRoot}${result.withSkill ? ' (skill extras enabled)' : ''}.\n`);
            return;
        }
        if (command === 'upgrade') {
            const result = await upgradeProject({
                targetDir: options.targetDir,
                withSkill: options.withSkill,
            });
            process.stdout.write(`Upgraded agent-belay in ${result.repoRoot}.\n`);
            return;
        }
        if (command === 'doctor') {
            const report = await doctorProject({ targetDir: options.targetDir });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            }
            else {
                process.stdout.write(formatDoctorReport(report));
            }
            process.exitCode = report.ok ? 0 : 1;
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
            if (!options.explainCommand) {
                throw new Error('explain requires a command after --');
            }
            const report = await explainCommand({
                targetDir: options.targetDir,
                command: options.explainCommand,
                cwd: options.explainCwd,
                json: options.json,
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
