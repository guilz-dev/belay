import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfigFile, runtimeCorePath } from './config-io.js';
import { getManagedHookEntries } from './defaults.js';
import { loadHooksFile } from './installer.js';
import { resolveNodeBinary } from './node-resolution.js';
import { PACKAGE_VERSION } from './version.js';
async function readRuntimeVersion(corePath) {
    try {
        const content = await readFile(corePath, 'utf8');
        const stampMatch = content.match(/RUNTIME_BUILD_STAMP\s*=\s*"([^"]+)"/);
        const versionMatch = content.match(/RUNTIME_PACKAGE_VERSION\s*=\s*"([^"]+)"/);
        return {
            stamp: stampMatch?.[1],
            version: versionMatch?.[1],
        };
    }
    catch {
        return {};
    }
}
export async function doctorProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const cursorDir = path.join(repoRoot, '.cursor');
    const configPath = path.join(cursorDir, 'belay.config.json');
    const hooksPath = path.join(cursorDir, 'hooks.json');
    const corePath = runtimeCorePath(repoRoot);
    const issues = [];
    const notes = [];
    const warnings = [];
    if (!existsSync(configPath)) {
        issues.push(`Missing config: ${configPath}`);
    }
    else {
        try {
            const config = await loadConfigFile(repoRoot);
            if (config.version !== 2) {
                warnings.push(`Config version is ${config.version}; expected 2. Run agent-belay upgrade to migrate.`);
            }
            notes.push(`Config mode: ${config.mode}`);
        }
        catch (error) {
            issues.push(error instanceof Error ? error.message : 'Failed to parse belay.config.json');
        }
    }
    const requiredPaths = [
        path.join(cursorDir, 'hooks', 'belay-runner'),
        path.join(cursorDir, 'hooks', 'belay-runner.cmd'),
        path.join(cursorDir, 'hooks', 'belay-before-submit.mjs'),
        path.join(cursorDir, 'hooks', 'belay-shell-gate.mjs'),
        path.join(cursorDir, 'hooks', 'belay-tool-gate.mjs'),
        path.join(cursorDir, 'hooks', 'belay-audit.mjs'),
        corePath,
        path.join(cursorDir, 'belay', 'pending-approvals.json'),
        path.join(cursorDir, 'belay', 'approved-approvals.json'),
        path.join(cursorDir, 'belay', 'audit.ndjson'),
    ];
    for (const requiredPath of requiredPaths) {
        if (!existsSync(requiredPath)) {
            issues.push(`Missing generated file: ${requiredPath}`);
        }
    }
    let hooksOk = true;
    try {
        const hooksFile = await loadHooksFile(hooksPath);
        const managedEntries = getManagedHookEntries(process.platform);
        for (const { event, definition } of managedEntries) {
            const entries = hooksFile.hooks[event] ?? [];
            const present = entries.some((entry) => entry.command === definition.command && entry.matcher === definition.matcher);
            if (!present) {
                hooksOk = false;
                const matcherSuffix = definition.matcher ? ` (matcher: ${definition.matcher})` : '';
                issues.push(`Missing managed hook for ${event}: ${definition.command}${matcherSuffix}`);
            }
        }
    }
    catch (error) {
        hooksOk = false;
        issues.push(error instanceof Error ? error.message : 'Failed to parse hooks.json');
    }
    const nodeResolution = resolveNodeBinary();
    if (!nodeResolution.ok) {
        issues.push(nodeResolution.detail);
    }
    else {
        notes.push(`Node resolved at ${nodeResolution.path}`);
    }
    if (existsSync(corePath)) {
        const runtimeVersions = await readRuntimeVersion(corePath);
        if (runtimeVersions.stamp && runtimeVersions.stamp !== PACKAGE_VERSION) {
            warnings.push(`Installed runtime stamp (${runtimeVersions.stamp}) differs from package (${PACKAGE_VERSION}). Run agent-belay upgrade.`);
        }
        if (runtimeVersions.version && runtimeVersions.version !== PACKAGE_VERSION) {
            warnings.push(`Installed runtime version (${runtimeVersions.version}) differs from package (${PACKAGE_VERSION}). Run agent-belay upgrade.`);
        }
        if (runtimeVersions.stamp === PACKAGE_VERSION) {
            notes.push(`Runtime version matches package (${PACKAGE_VERSION}).`);
        }
    }
    const report = {
        ok: issues.length === 0 && hooksOk,
        repoRoot,
        configPath,
        hooksPath,
        nodeResolution,
        issues,
        notes,
        warnings,
    };
    return report;
}
export function formatDoctorReport(report) {
    const lines = [
        `agent-belay doctor for ${report.repoRoot}`,
        `Config: ${report.configPath}`,
        `Hooks: ${report.hooksPath}`,
        `Node: ${report.nodeResolution.ok ? report.nodeResolution.path : 'unresolved'}`,
    ];
    if (report.notes.length > 0) {
        lines.push('', 'Notes:');
        for (const note of report.notes) {
            lines.push(`- ${note}`);
        }
    }
    if (report.warnings.length > 0) {
        lines.push('', 'Warnings:');
        for (const warning of report.warnings) {
            lines.push(`- ${warning}`);
        }
    }
    if (report.issues.length > 0) {
        lines.push('', 'Issues:');
        for (const issue of report.issues) {
            lines.push(`- ${issue}`);
        }
    }
    else {
        lines.push('', 'No issues detected.');
    }
    return `${lines.join('\n')}\n`;
}
