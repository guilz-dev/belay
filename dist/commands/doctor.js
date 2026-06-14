import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getClaudeManagedHookEntries } from '../adapters/claude/hooks.js';
import { getCodexManagedHookEntries } from '../adapters/codex/hooks.js';
import { getAdapterLayout } from '../adapters/layouts/index.js';
import { resolveScopedPaths } from '../adapters/layouts/scope.js';
import { cleanupOrphanApprovalState } from '../cleanup-orphans.js';
import { approvedApprovalsPath, belayStateDir, detectAdapterName, loadLayeredConfig, pendingApprovalsPath, repoLocalStateDirFor, } from '../config-io.js';
import { detectFenceDrift, summarizeAuditVisibility } from '../core/audit-summary.js';
import { defaultControlPlaneDir } from '../core/config.js';
import { verifyIntegrityManifest } from '../core/integrity.js';
import { diagnoseJudge } from '../core/judge-doctor.js';
import { getManagedHookEntries } from '../defaults.js';
import { resolveNodeBinary } from '../node-resolution.js';
import { egressStatus } from '../services/egress-service.js';
import { sandboxStatus } from '../services/sandbox-service.js';
import { PACKAGE_VERSION } from '../version.js';
import { loadAuditRecords } from './audit.js';
import { collectHealthSnapshot } from './health-snapshot.js';
import { metricsProject } from './metrics.js';
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
function resolveDoctorAdapter(options, configAdapter) {
    if (options.adapter) {
        return options.adapter;
    }
    if (configAdapter === 'claude' || configAdapter === 'codex') {
        return configAdapter;
    }
    return 'cursor';
}
export async function doctorProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const issues = [];
    const notes = [];
    const warnings = [];
    let loadedConfig = null;
    let configProvenance = [];
    let adapterName = options.adapter ?? detectAdapterName(repoRoot);
    let activeLayout = getAdapterLayout(adapterName);
    let configPath = activeLayout.configPath(repoRoot);
    let hooksPath = activeLayout.hooksSettingsPath(repoRoot);
    let corePath = path.join(activeLayout.runtimeDir(repoRoot), 'core.mjs');
    if (!existsSync(configPath)) {
        issues.push(`Missing config: ${configPath}`);
    }
    else {
        try {
            const rawConfig = JSON.parse(await readFile(configPath, 'utf8'));
            adapterName = resolveDoctorAdapter(options, rawConfig.adapter);
            activeLayout = getAdapterLayout(adapterName);
            configPath = activeLayout.configPath(repoRoot);
            hooksPath = activeLayout.hooksSettingsPath(repoRoot);
            corePath = path.join(activeLayout.runtimeDir(repoRoot), 'core.mjs');
            if (rawConfig.version === undefined) {
                warnings.push('Config is missing "version". Set "version": 3 explicitly to avoid ambiguous migration.');
            }
            const layered = await loadLayeredConfig(repoRoot, adapterName);
            loadedConfig = layered.config;
            configProvenance = layered.provenance;
            for (const entry of layered.provenance) {
                notes.push(`Config layer [${entry.source}]: ${entry.path}`);
            }
            if (loadedConfig.version !== 4) {
                warnings.push(`Config version is ${loadedConfig.version}; expected 4. Run belay upgrade to migrate.`);
            }
            const judgeDoctor = await diagnoseJudge(loadedConfig);
            issues.push(...judgeDoctor.issues);
            warnings.push(...judgeDoctor.warnings);
            notes.push(...judgeDoctor.notes);
            notes.push(`Adapter: ${adapterName}`);
            const installScope = loadedConfig.installScope === 'global' ? 'global' : 'project';
            const scopedPaths = resolveScopedPaths(activeLayout, installScope, repoRoot);
            hooksPath = scopedPaths.hooksSettingsPath;
            corePath = path.join(scopedPaths.runtimeDir, 'core.mjs');
            notes.push(installScope === 'global'
                ? `Install scope: global (hooks/runtime at ${scopedPaths.hooksDir})`
                : 'Install scope: project');
            notes.push(`Config mode: ${loadedConfig.mode}`);
            notes.push('Verdict engine: v2 (location × opacity × effect × confidence). Shell gates use the v2 classifier; audit records include schemaVersion 2 axes when available.');
            const repoLocalDir = repoLocalStateDirFor(repoRoot, loadedConfig);
            if (loadedConfig.controlPlane.enabled) {
                notes.push(`Control plane: ${belayStateDir(loadedConfig, repoLocalDir)}`);
                const repoLocalPending = path.join(repoLocalDir, 'pending-approvals.json');
                const repoLocalApproved = path.join(repoLocalDir, 'approved-approvals.json');
                if (existsSync(repoLocalPending) || existsSync(repoLocalApproved)) {
                    warnings.push('Repo-local approval files remain while control plane is enabled. Run belay doctor --fix to archive them.');
                }
            }
            else {
                const controlPlaneDirs = new Set([defaultControlPlaneDir()]);
                if (loadedConfig.controlPlane.configDir) {
                    controlPlaneDirs.add(loadedConfig.controlPlane.configDir);
                }
                for (const controlPlaneDir of controlPlaneDirs) {
                    const hasApprovalFiles = existsSync(path.join(controlPlaneDir, 'pending-approvals.json')) ||
                        existsSync(path.join(controlPlaneDir, 'approved-approvals.json'));
                    if (hasApprovalFiles) {
                        warnings.push(`Control plane is disabled but approval files still exist at ${controlPlaneDir}. Run belay doctor --fix to migrate and archive them.`);
                    }
                }
            }
            if (loadedConfig.controlPlane.integrity === 'hash-pinned') {
                notes.push('Integrity: hash-pinned (verify with belay upgrade after runtime changes).');
                const integrity = await verifyIntegrityManifest(repoRoot, activeLayout);
                if (!integrity.ok) {
                    issues.push(`Integrity verification failed: ${integrity.mismatches.slice(0, 3).join(', ')}`);
                }
            }
        }
        catch (error) {
            issues.push(error instanceof Error ? error.message : 'Failed to parse belay.config.json');
        }
    }
    const installScope = loadedConfig?.installScope === 'global' ? 'global' : 'project';
    const scopedPaths = resolveScopedPaths(activeLayout, installScope, repoRoot);
    hooksPath = scopedPaths.hooksSettingsPath;
    corePath = path.join(scopedPaths.runtimeDir, 'core.mjs');
    const hooksDir = scopedPaths.hooksDir;
    const repoLocalDir = loadedConfig
        ? repoLocalStateDirFor(repoRoot, loadedConfig)
        : activeLayout.repoLocalStateDir(repoRoot);
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
    ];
    for (const requiredPath of requiredPaths) {
        if (!existsSync(requiredPath)) {
            issues.push(`Missing generated file: ${requiredPath}`);
        }
    }
    let hooksOk = true;
    try {
        const managedEntries = adapterName === 'cursor'
            ? getManagedHookEntries(process.platform, hooksDir, repoRoot)
            : adapterName === 'claude'
                ? getClaudeManagedHookEntries(process.platform, hooksDir, repoRoot)
                : getCodexManagedHookEntries(process.platform, hooksDir, repoRoot);
        if (adapterName === 'cursor') {
            const { loadHooksFile } = await import('../installer.js');
            const hooksFile = await loadHooksFile(hooksPath);
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
        else if (adapterName === 'codex') {
            // Codex hooks live in TOML (.codex/config.toml). Verify belay's managed command strings
            // are present in the rendered TOML block.
            const toml = await readFile(hooksPath, 'utf8');
            for (const { event, definition } of managedEntries) {
                if (!toml.includes(definition.command)) {
                    hooksOk = false;
                    issues.push(`Missing Codex managed hook for ${event}: ${definition.command}`);
                }
            }
            // Codex adapter: shell gating VERIFIED end-to-end on Codex TUI (PreToolUse deny honored;
            // Codex TUI smoke / G-B2). Surface only the residual caveats so users know the boundary.
            warnings.push('Codex adapter: shell gating verified on Codex TUI (PreToolUse deny honored). Residual ' +
                'caveats — only the shell (Bash) tool is confirmed; non-shell tool names (apply_patch ' +
                'etc.) are best-guess mappings; unmapped tools ask with pending approval (R39); managed ' +
                '(pre-trusted) deployment is not yet available; non-managed hooks require /hooks trust. ' +
                'See docs/adapter-sdk.md and docs/gates/G-B1-cursor-skill-ux.md.');
        }
        else {
            const settings = JSON.parse(await readFile(hooksPath, 'utf8'));
            for (const { event, definition } of managedEntries) {
                const eventHooks = settings.hooks?.[event] ?? [];
                const present = eventHooks.some((entry) => entry.matcher === definition.matcher &&
                    entry.hooks?.some((hook) => hook.command === definition.command));
                if (!present) {
                    hooksOk = false;
                    issues.push(`Missing Claude managed hook for ${event}: ${definition.command}`);
                }
            }
        }
    }
    catch (error) {
        hooksOk = false;
        issues.push(error instanceof Error ? error.message : 'Failed to parse hook settings');
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
        if (runtimeVersions.stamp && !runtimeVersions.stamp.startsWith(`${PACKAGE_VERSION}@`)) {
            warnings.push(`Installed runtime stamp (${runtimeVersions.stamp}) differs from package (${PACKAGE_VERSION}). Run belay upgrade.`);
        }
        if (runtimeVersions.version && runtimeVersions.version !== PACKAGE_VERSION) {
            warnings.push(`Installed runtime version (${runtimeVersions.version}) differs from package (${PACKAGE_VERSION}). Run belay upgrade.`);
        }
        if (runtimeVersions.stamp?.startsWith(`${PACKAGE_VERSION}@`)) {
            notes.push(`Runtime version matches package (${PACKAGE_VERSION}).`);
        }
    }
    if (options.fix && loadedConfig) {
        const cleanup = await cleanupOrphanApprovalState(repoRoot, loadedConfig, {
            dryRun: options.dryRun === true,
        });
        if (cleanup.actions.length > 0) {
            notes.push(...cleanup.actions);
        }
        else {
            notes.push('No orphan approval cleanup actions were needed.');
        }
    }
    let dogfood = null;
    if (loadedConfig) {
        const auditRecords = await loadAuditRecords(repoRoot);
        const auditVisibility = summarizeAuditVisibility(auditRecords);
        const drift = detectFenceDrift(auditVisibility, {
            threshold: loadedConfig.policy.fenceWarnThreshold,
        });
        warnings.push(...drift.warnings);
        notes.push(...drift.notes);
        const metrics = await metricsProject({ targetDir: repoRoot });
        dogfood = {
            active: loadedConfig.mode === 'audit' && loadedConfig.policy.unknownLocalEffect === 'deny',
            mode: loadedConfig.mode,
            unknownLocalEffect: loadedConfig.policy.unknownLocalEffect,
            readyForEnforce: metrics.dogfood.readyForEnforce,
            gateEvents: metrics.gateEvents,
            wouldBlockCount: metrics.wouldBlockCount,
            wouldBlockRate: metrics.wouldBlockRate,
            notes: metrics.dogfood.notes,
        };
        if (dogfood.active) {
            notes.push(`Dogfood active: ${dogfood.gateEvents} gate events, ${dogfood.wouldBlockCount} would-block (${(dogfood.wouldBlockRate * 100).toFixed(1)}%).`);
            if (dogfood.readyForEnforce) {
                notes.push('Dogfood metrics suggest enforce mode is ready (belay dogfood --enforce).');
            }
        }
        else if (dogfood.unknownLocalEffect === 'deny' && dogfood.mode !== 'audit') {
            notes.push('Fail-closed policy is enabled in enforce mode.');
        }
        if (loadedConfig.policy.transactional.enabled) {
            notes.push('Transactional execution: enabled — low-confidence shell mutations run in an isolated git worktree; observed-safe effects are applied once and the hook denies re-execution.');
            if (!existsSync(path.join(repoRoot, '.git'))) {
                warnings.push('Transactional execution is enabled but this directory is not a git repository. Transactional worktrees will be skipped until git is available.');
            }
        }
        if (loadedConfig.sandbox.enabled) {
            const sandbox = await sandboxStatus({ targetDir: repoRoot });
            notes.push(`Sandbox capability broker: enabled (runtime=${loadedConfig.sandbox.runtime}, fs-scope entries=${sandbox.fsScopeAllowlistCount}, full-isolation=${sandbox.l1FullActive}).`);
            if (loadedConfig.sandbox.runtime === 'none') {
                warnings.push('sandbox.enabled is true but sandbox.runtime is none.');
            }
            for (const issue of sandbox.issues) {
                warnings.push(issue);
            }
        }
        if (loadedConfig.egress.enabled) {
            const egress = await egressStatus({ targetDir: repoRoot });
            notes.push(`Egress proxy: enabled — read/mutate action class enforced at proxy layer (listen ${egress.host}:${egress.port}; demoteL3External config is legacy and not applied to shell classifier).`);
            if (!egress.running) {
                warnings.push('Egress is enabled in config but the local proxy is not running. Run belay egress start.');
            }
            else {
                notes.push(`Egress proxy running (pid ${egress.pid}).`);
                if (egress.foreignProxy) {
                    warnings.push(`Egress listen port ${egress.host}:${egress.port} is occupied by another proxy${egress.boundRepoRoot ? ` for ${egress.boundRepoRoot}` : ''}. Do not use belay egress env for this repository.`);
                }
                else if (egress.repoRootMismatch) {
                    warnings.push(`Egress proxy is bound to ${egress.boundRepoRoot} but this repo is ${repoRoot}. Stop and restart egress for this repository.`);
                }
            }
        }
    }
    const health = await collectHealthSnapshot({ targetDir: repoRoot, adapter: adapterName });
    if (health.containmentPosture !== 'l1-full') {
        warnings.push(`Containment posture is ${health.containmentPosture}: ${health.containmentWarnings.join('; ')}`);
    }
    for (const signal of health.additionalRiskSignals) {
        warnings.push(`Additional risk signal: ${signal}`);
    }
    if (health.skillOnly) {
        warnings.push('Skill-only install detected: belay SKILL.md is present but hook floor is missing or incomplete. ' +
            'This is advisory only — enforcement requires hooks. Run `npx @guilz-dev/belay init` (or `belay init-wizard`) ' +
            'then `belay doctor` to verify the floor.');
        notes.push(`Skill path: ${health.skillPath}`);
    }
    if (health.skillInstalled && !health.commandsInstalled && adapterName === 'cursor') {
        notes.push('Optional: install Cursor slash commands with `belay init --with-skill` for /belay-approve routing.');
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
        configProvenance,
        dogfood,
    };
    return report;
}
export function formatDoctorReport(report) {
    const lines = [
        `belay doctor for ${report.repoRoot}`,
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
    if (report.dogfood) {
        lines.push('', `Dogfood: ${report.dogfood.active ? 'active' : 'inactive'} | enforce ready: ${report.dogfood.readyForEnforce ? 'yes' : 'no'}`);
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
