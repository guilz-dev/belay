import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function sha256File(filePath) {
    const content = await readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
}
export function integrityManifestPath(layout, repoRoot) {
    return path.join(layout.repoLocalStateDir(repoRoot), 'integrity-manifest.json');
}
export function runtimeIntegrityFiles(layout, repoRoot) {
    const hooksDir = layout.hooksDir(repoRoot);
    const runtimeDir = layout.runtimeDir(repoRoot);
    return [
        layout.configPath(repoRoot),
        layout.hooksSettingsPath(repoRoot),
        path.join(hooksDir, 'belay-before-submit.mjs'),
        path.join(hooksDir, 'belay-shell-gate.mjs'),
        path.join(hooksDir, 'belay-tool-gate.mjs'),
        path.join(hooksDir, 'belay-audit.mjs'),
        path.join(hooksDir, 'belay-runner'),
        path.join(hooksDir, 'belay-runner.cmd'),
        path.join(runtimeDir, 'core.mjs'),
    ];
}
export async function writeIntegrityManifest(repoRoot, layout, filePaths) {
    const files = {};
    for (const filePath of filePaths) {
        if (!existsSync(filePath)) {
            continue;
        }
        const relativePath = path.relative(repoRoot, filePath);
        files[relativePath] = await sha256File(filePath);
    }
    const manifest = {
        version: 1,
        generatedAt: new Date().toISOString(),
        files,
    };
    const manifestPath = integrityManifestPath(layout, repoRoot);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
export async function verifyIntegrityManifest(repoRoot, layout) {
    const manifestPath = integrityManifestPath(layout, repoRoot);
    if (!existsSync(manifestPath)) {
        return { ok: false, mismatches: ['missing integrity-manifest.json'] };
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const mismatches = [];
    for (const [relativePath, expectedHash] of Object.entries(manifest.files ?? {})) {
        const absolutePath = path.join(repoRoot, relativePath);
        if (!existsSync(absolutePath)) {
            mismatches.push(`missing ${relativePath}`);
            continue;
        }
        const actualHash = await sha256File(absolutePath);
        if (actualHash !== expectedHash) {
            mismatches.push(`hash mismatch ${relativePath}`);
        }
    }
    return { ok: mismatches.length === 0, mismatches };
}
