import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ScopedPaths } from '../adapters/layouts/scope.js'
import type { AdapterLayout } from '../adapters/layouts/types.js'

export interface IntegrityManifest {
  version: 1
  generatedAt: string
  files: Record<string, string>
}

export async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

export function integrityManifestPath(layout: AdapterLayout, repoRoot: string): string {
  return path.join(layout.repoLocalStateDir(repoRoot), 'integrity-manifest.json')
}

export function runtimeIntegrityFiles(_layout: AdapterLayout, paths: ScopedPaths): string[] {
  const files = [paths.configPath]
  if (paths.scope !== 'project') {
    return files
  }
  const hooksDir = paths.hooksDir
  const runtimeDir = paths.runtimeDir
  return [
    ...files,
    paths.hooksSettingsPath,
    path.join(hooksDir, 'belay-before-submit.mjs'),
    path.join(hooksDir, 'belay-shell-gate.mjs'),
    path.join(hooksDir, 'belay-tool-gate.mjs'),
    path.join(hooksDir, 'belay-audit.mjs'),
    path.join(hooksDir, 'belay-runner'),
    path.join(hooksDir, 'belay-runner.cmd'),
    path.join(runtimeDir, 'core.mjs'),
  ]
}

export async function writeIntegrityManifest(
  repoRoot: string,
  layout: AdapterLayout,
  filePaths: string[],
): Promise<void> {
  const files: Record<string, string> = {}
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) {
      continue
    }
    const relativePath = path.relative(repoRoot, filePath)
    files[relativePath] = await sha256File(filePath)
  }
  const manifest: IntegrityManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    files,
  }
  const manifestPath = integrityManifestPath(layout, repoRoot)
  await mkdir(path.dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

export async function verifyIntegrityManifest(
  repoRoot: string,
  layout: AdapterLayout,
): Promise<{ ok: boolean; mismatches: string[] }> {
  const manifestPath = integrityManifestPath(layout, repoRoot)
  if (!existsSync(manifestPath)) {
    return { ok: false, mismatches: ['missing integrity-manifest.json'] }
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as IntegrityManifest
  const mismatches: string[] = []
  for (const [relativePath, expectedHash] of Object.entries(manifest.files ?? {})) {
    const absolutePath = path.join(repoRoot, relativePath)
    if (!existsSync(absolutePath)) {
      mismatches.push(`missing ${relativePath}`)
      continue
    }
    const actualHash = await sha256File(absolutePath)
    if (actualHash !== expectedHash) {
      mismatches.push(`hash mismatch ${relativePath}`)
    }
  }
  return { ok: mismatches.length === 0, mismatches }
}
