import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CursorHookOrigin } from './adapters/cursor/hook-router.js'
import type { AdapterName } from './adapters/layouts/types.js'
import type { BelayConfigV3 } from './core/config.js'
import { hashValue } from './core/fingerprint.js'
import { PACKAGE_VERSION } from './version.js'

function inlineJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function renderConfig(config: BelayConfigV3): string {
  return `${inlineJson(config)}\n`
}

function requireCursorOrigin(origin: CursorHookOrigin | undefined): CursorHookOrigin {
  if (!origin) {
    throw new Error('Cursor hook origin is required when rendering dispatcher shims.')
  }
  return origin
}

function renderCursorDispatchHook(
  origin: CursorHookOrigin,
  kind: 'before-submit' | 'shell-gate' | 'tool-gate' | 'audit',
  eventName: string,
): string {
  return `import { dispatchCursorHook } from '../belay/runtime/dispatcher.mjs'

await dispatchCursorHook({
  origin: ${JSON.stringify(origin)},
  kind: ${JSON.stringify(kind)},
  eventName: ${eventName},
})
`
}

export function renderBeforeSubmitHook(
  adapter: AdapterName,
  cursorOrigin?: CursorHookOrigin,
): string {
  if (adapter === 'cursor') {
    return renderCursorDispatchHook(
      requireCursorOrigin(cursorOrigin),
      'before-submit',
      JSON.stringify('beforeSubmitPrompt'),
    )
  }
  return `import { runBeforeSubmitPromptHook } from '../belay/runtime/core.mjs'

await runBeforeSubmitPromptHook()
`
}

export function renderShellGateHook(adapter: AdapterName, cursorOrigin?: CursorHookOrigin): string {
  if (adapter === 'cursor') {
    return renderCursorDispatchHook(
      requireCursorOrigin(cursorOrigin),
      'shell-gate',
      JSON.stringify('beforeShellExecution'),
    )
  }
  return `import { runShellGateHook } from '../belay/runtime/core.mjs'

await runShellGateHook()
`
}

export function renderToolGateHook(adapter: AdapterName, cursorOrigin?: CursorHookOrigin): string {
  if (adapter === 'cursor') {
    return renderCursorDispatchHook(
      requireCursorOrigin(cursorOrigin),
      'tool-gate',
      "process.argv[2] ?? 'preToolUse'",
    )
  }
  return `import { runToolGateHook } from '../belay/runtime/core.mjs'

const eventName = process.argv[2] ?? 'preToolUse'
await runToolGateHook(eventName)
`
}

export function renderAuditHook(adapter: AdapterName, cursorOrigin?: CursorHookOrigin): string {
  if (adapter === 'cursor') {
    return renderCursorDispatchHook(
      requireCursorOrigin(cursorOrigin),
      'audit',
      "process.argv[2] ?? 'postToolUse'",
    )
  }
  return `import { runAuditHook } from '../belay/runtime/core.mjs'

const eventName = process.argv[2] ?? 'postToolUse'
await runAuditHook(eventName)
`
}

async function readRuntimeBundle(
  adapter: 'cursor' | 'claude' | 'codex' = 'cursor',
): Promise<string> {
  const bundlePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'dist',
    'bundle',
    `${adapter}-runtime.mjs`,
  )
  try {
    return await readFile(bundlePath, 'utf8')
  } catch {
    throw new Error('Runtime bundle missing. Run pnpm build before belay init or upgrade.')
  }
}

export async function renderCursorDispatcher(): Promise<string> {
  const bundlePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'dist',
    'bundle',
    'cursor-dispatcher.mjs',
  )
  try {
    return await readFile(bundlePath, 'utf8')
  } catch {
    throw new Error('Runtime bundle missing. Run pnpm build before belay init or upgrade.')
  }
}

export async function renderRuntimeCore(
  adapter: 'cursor' | 'claude' | 'codex' = 'cursor',
): Promise<string> {
  const bundle = await readRuntimeBundle(adapter)
  const withoutStamp = bundle
    .replace(/^export const RUNTIME_BUILD_STAMP = .*;\n/gm, '')
    .replace(/^export const RUNTIME_PACKAGE_VERSION = .*;\n/gm, '')
    .replace(/^export const RUNTIME_ARTIFACT_HASH = .*;\n/gm, '')
    .replace(/^var RUNTIME_PACKAGE_VERSION = .*;\n/gm, '')
    .replace(/\n {2}RUNTIME_PACKAGE_VERSION,\n/, '\n')
  const runtimeArtifactHash = hashValue(withoutStamp)
  const runtimeBuildStamp = `${PACKAGE_VERSION}@${runtimeArtifactHash.slice(0, 16)}`
  const stamp = `export const RUNTIME_BUILD_STAMP = ${JSON.stringify(runtimeBuildStamp)};\n`
  const artifactHashLine = `export const RUNTIME_ARTIFACT_HASH = ${JSON.stringify(runtimeArtifactHash)};\n`
  const versionLine = `export const RUNTIME_PACKAGE_VERSION = ${JSON.stringify(PACKAGE_VERSION)};\n`
  const provenance = `globalThis[Symbol.for("agent-belay.runtime-provenance")] = ${JSON.stringify({
    runtimeVersion: PACKAGE_VERSION,
    runtimeBuildStamp,
    runtimeArtifactHash,
  })};\n`
  return `${versionLine}${artifactHashLine}${stamp}${provenance}${withoutStamp}`
}
