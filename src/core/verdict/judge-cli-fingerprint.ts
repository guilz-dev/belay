import { spawn } from 'node:child_process'

import type { JudgeProviderId } from './judge-catalog.js'

const CLI_BINARIES: Record<Exclude<JudgeProviderId, 'ollama'>, string> = {
  codex: 'codex',
  cursor: 'cursor-agent',
  claude: 'claude',
}

export type CliFingerprintResolver = (
  providerId: Exclude<JudgeProviderId, 'ollama'>,
) => Promise<string>

let fingerprintResolver: CliFingerprintResolver | null = null
const fingerprintCache = new Map<string, string>()

export function setCliFingerprintResolverForTests(resolver: CliFingerprintResolver | null): void {
  fingerprintResolver = resolver
  fingerprintCache.clear()
}

async function runVersionProbe(binary: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${binary} --version timed out`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const output = (stdout || stderr).trim()
      if (code === 0 && output) {
        resolve(output.split(/\r?\n/)[0]?.trim() || output)
        return
      }
      reject(
        new Error(stderr.trim() || `${binary} --version exited with code ${code ?? 'unknown'}`),
      )
    })
  })
}

export async function resolveCliVersionFingerprint(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  timeoutMs = 3_000,
): Promise<string> {
  const cacheKey = providerId
  const cached = fingerprintCache.get(cacheKey)
  if (cached) {
    return cached
  }

  if (fingerprintResolver) {
    const resolved = await fingerprintResolver(providerId)
    fingerprintCache.set(cacheKey, resolved)
    return resolved
  }

  const binary = CLI_BINARIES[providerId]
  const version = await runVersionProbe(binary, timeoutMs)
  fingerprintCache.set(cacheKey, version)
  return version
}

export function resetCliFingerprintCache(): void {
  fingerprintCache.clear()
}
