import { MAX_SHELL_COMMAND_BYTES } from '../capability/limits.js'
import type { ParsedShellProgram } from './types.js'

/**
 * Production Wasm is not shipped until the disposable probe passes.
 * Missing artifacts are an availability failure, never an allow.
 */
export function parseMvdanShell(command: string): ParsedShellProgram {
  const sourceBytes = Buffer.byteLength(command, 'utf8')
  const span = { startByte: 0, endByte: sourceBytes }
  if (sourceBytes > MAX_SHELL_COMMAND_BYTES) {
    return {
      version: 1,
      sourceBytes,
      completeness: 'partial',
      nodes: [{ kind: 'unsupported', upstreamKind: 'input_limit', span }],
      diagnostics: [{ code: 'node_limit', span }],
    }
  }
  return {
    version: 1,
    sourceBytes,
    completeness: 'partial',
    nodes: [{ kind: 'unsupported', upstreamKind: 'mvdan_artifact_missing', span }],
    diagnostics: [{ code: 'artifact_unavailable', span }],
  }
}

export const mvdanShellFrontend = {
  id: 'mvdan-v1' as const,
  parse(command: string): Promise<ParsedShellProgram> {
    return Promise.resolve(parseMvdanShell(command))
  },
}
