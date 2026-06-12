import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfigFile } from '../config-io.js';
import { detectBypassAttempts, detectNoisyRules } from '../core/audit-analysis.js';
import { parseAuditNdjson, toAuditRecord } from '../core/audit-metrics.js';
import { buildApprovalRoundTrips, filterAuditRecords, summarizeRoundTrips, } from '../core/audit-query.js';
import { mergeConfig } from '../core/config.js';
import { diffReclassification } from '../core/reclassify.js';
async function loadAuditRecords(repoRoot) {
    const config = await loadConfigFile(repoRoot);
    const auditLogPath = path.join(repoRoot, config.audit.logPath);
    let raw = '';
    try {
        raw = await readFile(auditLogPath, 'utf8');
    }
    catch {
        raw = '';
    }
    return parseAuditNdjson(raw).map(toAuditRecord);
}
export async function auditProject(options) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const records = await loadAuditRecords(repoRoot);
    const filter = {
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
    };
    if (options.subcommand === 'query') {
        const filtered = filterAuditRecords(records, filter);
        return { subcommand: 'query', records: filtered, count: filtered.length };
    }
    if (options.subcommand === 'summarize') {
        const filtered = filterAuditRecords(records, filter);
        const trips = buildApprovalRoundTrips(filtered);
        const bypassAttempts = detectBypassAttempts(filtered);
        const noisyRules = detectNoisyRules(filtered, trips);
        return {
            subcommand: 'summarize',
            roundTrips: trips,
            lines: summarizeRoundTrips(trips),
            bypassAttempts,
            noisyRules,
        };
    }
    const config = await loadConfigFile(repoRoot);
    let candidateConfig = config;
    let configWarning;
    if (options.configPath) {
        if (!existsSync(options.configPath)) {
            configWarning = `Candidate config not found: ${options.configPath}`;
        }
        else {
            const raw = JSON.parse(await readFile(options.configPath, 'utf8'));
            candidateConfig = mergeConfig(raw, config);
        }
    }
    const filtered = filterAuditRecords(records, filter);
    const diffs = (await Promise.all(filtered.map((record) => diffReclassification(record, candidateConfig, repoRoot)))).filter((diff) => diff !== null);
    return {
        subcommand: 'replay',
        candidateConfigPath: options.configPath ?? null,
        configWarning,
        changedCount: diffs.length,
        diffs,
    };
}
export function formatAuditReport(report) {
    if (report.subcommand === 'query') {
        const records = report.records ?? [];
        const count = report.count ?? records.length;
        const lines = [`audit query: ${count} record(s)`];
        for (const record of records.slice(0, 50)) {
            const v2Axes = typeof record.location === 'string'
                ? ` location=${record.location} opacity=${record.opacity ?? '?'} effect=${record.effect ?? '?'} confidence=${record.confidence ?? '?'}`
                : '';
            lines.push(`- ${record.timestamp ?? '?'} [${record.event ?? '?'}] ${record.verdict ?? '?'} (${record.reason ?? '?'})${v2Axes} ${record.summary ?? ''}`);
        }
        if (count > 50) {
            lines.push(`... ${count - 50} more`);
        }
        return `${lines.join('\n')}\n`;
    }
    if (report.subcommand === 'summarize') {
        const lines = ['audit summarize:', ''];
        const summaryLines = report.lines ?? [];
        const bypassAttempts = report.bypassAttempts ?? [];
        const noisyRules = report.noisyRules ?? [];
        if (summaryLines.length === 0) {
            lines.push('No deny → approve → execute round-trips found.');
        }
        else {
            lines.push('Round-trips:');
            for (const line of summaryLines) {
                lines.push(`- ${line}`);
            }
        }
        if (bypassAttempts.length > 0) {
            lines.push('', `Bypass attempts (${bypassAttempts.length}):`);
            for (const attempt of bypassAttempts.slice(0, 10)) {
                lines.push(`- [${attempt.signal}] denied "${attempt.denySummary}" → tried "${attempt.attemptSummary}"`);
            }
        }
        if (noisyRules.length > 0) {
            lines.push('', 'Noisy rule candidates:');
            for (const rule of noisyRules) {
                lines.push(`- ${rule.reason}: ${(rule.approvalRate * 100).toFixed(0)}% approved after deny (${rule.approvedCount}/${rule.denyCount})`);
            }
        }
        return `${lines.join('\n')}\n`;
    }
    const lines = [
        `audit replay: ${report.changedCount} verdict change(s)`,
        report.candidateConfigPath ? `Candidate config: ${report.candidateConfigPath}` : '',
        report.configWarning ?? '',
    ].filter(Boolean);
    const diffs = report.diffs ?? [];
    for (const diff of diffs.slice(0, 30)) {
        lines.push(`- ${diff.summary ?? diff.fingerprint}: ${diff.previousVerdict}/${diff.previousReason} → ${diff.nextVerdict}/${diff.nextReason}`);
    }
    return `${lines.join('\n')}\n`;
}
