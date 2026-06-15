import { stdin as input } from 'node:process'

export async function readKeyFromStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}
