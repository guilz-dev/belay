import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BelayConfigV2 } from './core/config.js'
import { PACKAGE_VERSION } from './version.js'

function inlineJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function renderConfig(config: BelayConfigV2): string {
  return `${inlineJson(config)}\n`
}

export function renderBeforeSubmitHook(): string {
  return `import { runBeforeSubmitPromptHook } from '../belay/runtime/core.mjs'

await runBeforeSubmitPromptHook()
`
}

export function renderShellGateHook(): string {
  return `import { runShellGateHook } from '../belay/runtime/core.mjs'

await runShellGateHook()
`
}

export function renderToolGateHook(): string {
  return `import { runToolGateHook } from '../belay/runtime/core.mjs'

const eventName = process.argv[2] ?? 'preToolUse'
await runToolGateHook(eventName)
`
}

export function renderAuditHook(): string {
  return `import { runAuditHook } from '../belay/runtime/core.mjs'

const eventName = process.argv[2] ?? 'postToolUse'
await runAuditHook(eventName)
`
}

async function readRuntimeBundle(): Promise<string> {
  const bundlePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'dist',
    'bundle',
    'cursor-runtime.mjs',
  )
  try {
    return await readFile(bundlePath, 'utf8')
  } catch {
    throw new Error('Runtime bundle missing. Run pnpm build before agent-belay init or upgrade.')
  }
}

export async function renderRuntimeCore(): Promise<string> {
  const bundle = await readRuntimeBundle()
  if (bundle.includes('RUNTIME_BUILD_STAMP')) {
    return bundle
  }
  const stamp = `export const RUNTIME_BUILD_STAMP = ${JSON.stringify(PACKAGE_VERSION)};\n`
  return `${stamp}${bundle}`
}
