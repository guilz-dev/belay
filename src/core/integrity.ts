import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getAdapterLayout } from '../adapters/layouts/index.js'
import type { ScopedPaths } from '../adapters/layouts/scope.js'
import { isPathInside, resolveScopedPaths } from '../adapters/layouts/scope.js'
import type { AdapterLayout } from '../adapters/layouts/types.js'
import { resolveAdapterName } from '../config-io.js'
import type { BelayConfigV4 } from './config.js'

export interface IntegrityManifest {
  version: 1
  generatedAt: string
  files: Record<string, string>
}

const GLOBAL_INTEGRITY_PREFIX = '@global/'

function portableRelativePath(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/')
}

function integrityManifestFileKey(
  repoRoot: string,
  layout: AdapterLayout,
  filePath: string,
): string {
  const absolutePath = path.resolve(filePath)
  if (isPathInside(absolutePath, repoRoot)) {
    return portableRelativePath(repoRoot, absolutePath)
  }
  const globalPaths = resolveScopedPaths(layout, 'global', repoRoot)
  const globalAgentDir = path.dirname(globalPaths.hooksSettingsPath)
  if (isPathInside(absolutePath, globalAgentDir)) {
    return `${GLOBAL_INTEGRITY_PREFIX}${portableRelativePath(globalAgentDir, absolutePath)}`
  }
  throw new Error(`Integrity file is outside the repository and global adapter root: ${filePath}`)
}

export async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

export function integrityManifestPath(layout: AdapterLayout, repoRoot: string): string {
  return path.join(layout.repoLocalStateDir(repoRoot), 'integrity-manifest.json')
}

export function runtimeIntegrityFiles(layout: AdapterLayout, paths: ScopedPaths): string[] {
  const files = [paths.configPath]
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
    ...(layout.name === 'cursor' ? [path.join(hooksDir, 'belay-runner.ps1')] : []),
    path.join(runtimeDir, 'core.mjs'),
    ...(layout.name === 'cursor' ? [path.join(runtimeDir, 'dispatcher.mjs')] : []),
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
    const manifestKey = integrityManifestFileKey(repoRoot, layout, filePath)
    files[manifestKey] = await sha256File(filePath)
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
  requiredFilePaths: string[] = [],
): Promise<{ ok: boolean; mismatches: string[] }> {
  const manifestPath = integrityManifestPath(layout, repoRoot)
  if (!existsSync(manifestPath)) {
    return { ok: false, mismatches: ['missing integrity-manifest.json'] }
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as IntegrityManifest
  const mismatches: string[] = []
  const requiredPathsByKey = new Map(
    requiredFilePaths.map((requiredPath) => [
      integrityManifestFileKey(repoRoot, layout, requiredPath),
      path.resolve(requiredPath),
    ]),
  )
  for (const requiredPath of requiredFilePaths) {
    const requiredKey = integrityManifestFileKey(repoRoot, layout, requiredPath)
    if (!Object.hasOwn(manifest.files ?? {}, requiredKey)) {
      mismatches.push(`missing integrity pin ${requiredKey}`)
    }
  }
  for (const [manifestKey, expectedHash] of Object.entries(manifest.files ?? {})) {
    let absolutePath: string
    if (manifestKey.startsWith(GLOBAL_INTEGRITY_PREFIX)) {
      const requiredPath = requiredPathsByKey.get(manifestKey)
      if (!requiredPath) {
        mismatches.push(`unrecognized global integrity pin ${manifestKey}`)
        continue
      }
      absolutePath = requiredPath
    } else {
      absolutePath = path.resolve(repoRoot, manifestKey)
      if (!isPathInside(absolutePath, repoRoot)) {
        mismatches.push(`integrity pin escapes repository ${manifestKey}`)
        continue
      }
    }
    if (!existsSync(absolutePath)) {
      mismatches.push(`missing ${manifestKey}`)
      continue
    }
    const actualHash = await sha256File(absolutePath)
    if (actualHash !== expectedHash) {
      mismatches.push(`hash mismatch ${manifestKey}`)
    }
  }
  return { ok: mismatches.length === 0, mismatches }
}

export async function refreshIntegrityIfPinned(
  repoRoot: string,
  config: BelayConfigV4,
): Promise<void> {
  if (config.controlPlane.integrity !== 'hash-pinned') {
    return
  }
  const adapter = resolveAdapterName(config)
  const layout = getAdapterLayout(adapter)
  const installScope = config.installScope === 'global' ? 'global' : 'project'
  const scoped = resolveScopedPaths(layout, installScope, repoRoot)
  await writeIntegrityManifest(repoRoot, layout, runtimeIntegrityFiles(layout, scoped))
}
