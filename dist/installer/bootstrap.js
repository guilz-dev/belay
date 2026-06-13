import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { approvedApprovalsPath, pendingApprovalsPath } from '../config-io.js';
import { EMPTY_APPROVALS } from '../defaults.js';
const BUNDLED_SKILL_TEMPLATE_URL = new URL('../../skills/belay/SKILL.md', import.meta.url);
const BUNDLED_COMMAND_TEMPLATES = [
    'belay-approve.md',
    'belay-why.md',
    'belay-explain.md',
    'belay-status.md',
];
async function readBundledTemplate(fileUrl) {
    try {
        return await readFile(fileUrl, 'utf8');
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown read failure.';
        throw new Error(`Bundled template missing at ${fileUrl.pathname}: ${detail}`);
    }
}
async function writeJsonIfMissing(filePath, value) {
    if (existsSync(filePath)) {
        return;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
async function writeTextIfMissing(filePath, content) {
    if (existsSync(filePath)) {
        return;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
}
export async function bootstrapStateFiles(repoRoot, config, paths) {
    await mkdir(paths.repoLocalStateDir, { recursive: true });
    await mkdir(path.join(paths.repoLocalStateDir, 'runtime'), { recursive: true });
    await writeJsonIfMissing(pendingApprovalsPath(repoRoot, config), EMPTY_APPROVALS);
    await writeJsonIfMissing(approvedApprovalsPath(repoRoot, config), EMPTY_APPROVALS);
    const auditPath = path.join(repoRoot, config.audit.logPath);
    if (!existsSync(auditPath)) {
        await mkdir(path.dirname(auditPath), { recursive: true });
        await writeFile(auditPath, '', 'utf8');
    }
    await writeTextIfMissing(path.join(paths.repoLocalStateDir, 'audit.ndjson'), '');
}
export async function writeSkillArtifacts(adapterName, paths) {
    await mkdir(paths.skillsDir, { recursive: true });
    const bundledSkill = await readBundledTemplate(BUNDLED_SKILL_TEMPLATE_URL);
    await writeFile(path.join(paths.skillsDir, 'SKILL.md'), bundledSkill, 'utf8');
    if (adapterName === 'cursor' && paths.commandsDir) {
        await mkdir(paths.commandsDir, { recursive: true });
        for (const fileName of BUNDLED_COMMAND_TEMPLATES) {
            const bundledCommand = await readBundledTemplate(new URL(`../../skills/belay/${fileName}`, import.meta.url));
            await writeFile(path.join(paths.commandsDir, fileName), bundledCommand, 'utf8');
        }
    }
}
