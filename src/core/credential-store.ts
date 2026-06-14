import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const STORE_FILENAME = 'credentials.json'

export interface JudgeCredentialStoreFile {
  version: 1
  judge?: string
}

export function credentialStorePath(stateDir: string): string {
  return path.join(stateDir, STORE_FILENAME)
}

export async function writeJudgeCredentialStore(stateDir: string, apiKey: string): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const filePath = credentialStorePath(stateDir)
  const payload: JudgeCredentialStoreFile = {
    version: 1,
    judge: apiKey.trim(),
  }
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmod(filePath, 0o600)
  return filePath
}

export async function readJudgeCredentialStore(stateDir: string): Promise<string | null> {
  const filePath = credentialStorePath(stateDir)
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as JudgeCredentialStoreFile
    const key = parsed.judge?.trim()
    return key || null
  } catch {
    return null
  }
}

export async function judgeCredentialStoreExists(stateDir: string): Promise<boolean> {
  try {
    await readFile(credentialStorePath(stateDir), 'utf8')
    return true
  } catch {
    return false
  }
}

export type CredentialRef = `store:judge` | `env:${string}`

export function parseCredentialRef(ref: string): CredentialRef | null {
  if (ref === 'store:judge') {
    return ref
  }
  if (ref.startsWith('env:') && ref.length > 4) {
    return ref as `env:${string}`
  }
  return null
}
