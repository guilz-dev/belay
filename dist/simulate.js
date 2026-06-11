import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfigFile } from './config-io.js';
import { parseAuditNdjson, toAuditRecord } from './core/audit-metrics.js';
import { mergeConfig } from './core/config.js';
import { diffReclassification } from './core/reclassify.js';
export async function simulateProject(options) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const currentConfig = await loadConfigFile(repoRoot);
    if (!existsSync(options.configPath)) {
        throw new Error(`Candidate config not found: ${options.configPath}`);
    }
    const candidateRaw = JSON.parse(await readFile(options.configPath, 'utf8'));
    const candidateConfig = mergeConfig(candidateRaw, currentConfig);
    const auditLogPath = path.join(repoRoot, currentConfig.audit.logPath);
    let raw = '';
    try {
        raw = await readFile(auditLogPath, 'utf8');
    }
    catch {
        raw = '';
    }
    const records = parseAuditNdjson(raw).map(toAuditRecord);
    const diffs = records
        .map((record) => diffReclassification(record, candidateConfig, repoRoot))
        .filter((diff) => diff !== null);
    const allowToDeny = diffs.filter((diff) => (diff.previousVerdict === 'allow' || diff.previousVerdict === 'allow_flagged') &&
        diff.nextVerdict === 'deny_pending_approval');
    const denyToAllow = diffs.filter((diff) => diff.previousVerdict === 'deny_pending_approval' &&
        (diff.nextVerdict === 'allow' || diff.nextVerdict === 'allow_flagged'));
    return {
        candidateConfigPath: options.configPath,
        totalRecords: records.length,
        changedCount: diffs.length,
        allowToDenyCount: allowToDeny.length,
        denyToAllowCount: denyToAllow.length,
        diffs,
    };
}
export function formatSimulateReport(report) {
    const lines = [
        `simulate ${report.candidateConfigPath}`,
        `Records scanned: ${report.totalRecords}`,
        `Verdict changes: ${report.changedCount}`,
        `allow/flagged → deny: ${report.allowToDenyCount}`,
        `deny → allow/flagged: ${report.denyToAllowCount}`,
        '',
    ];
    for (const diff of report.diffs.slice(0, 30)) {
        lines.push(`- ${diff.summary ?? diff.fingerprint}: ${diff.previousVerdict}/${diff.previousReason} → ${diff.nextVerdict}/${diff.nextReason}`);
    }
    if (report.diffs.length > 30) {
        lines.push(`... ${report.diffs.length - 30} more`);
    }
    return `${lines.join('\n')}\n`;
}
