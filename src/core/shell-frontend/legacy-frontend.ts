import { MAX_SHELL_COMMAND_BYTES } from '../capability/limits.js'
import { tokenizeShell } from '../shell-tokenizer.js'
import { detectUnparseableShell } from '../shell-unparseable.js'
import { validateParsedProgram } from './span.js'
import type { ParsedShellProgram, ShellSyntaxNode, ShellWord } from './types.js'

const ENV_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)$/
const UNPROJECTED_STRUCTURE = /&&|\|\||[|;&<>\n\r]|\$\(|`|<\(|<</

export function parseLegacyShell(command: string): ParsedShellProgram {
  const sourceBytes = Buffer.byteLength(command, 'utf8')
  const span = { startByte: 0, endByte: sourceBytes }
  if (sourceBytes > MAX_SHELL_COMMAND_BYTES) {
    return partial(sourceBytes, 'node_limit', 'input_limit')
  }
  if (detectUnparseableShell(command)) {
    return partial(sourceBytes, 'invalid_syntax', 'legacy_unparseable')
  }

  const tokens = tokenizeShell(command)
  const located = locateWords(command, tokens)
  if (!located) {
    return partial(sourceBytes, 'unsupported_node', 'legacy_token_span')
  }

  const assignments: ShellWord[] = []
  const words: ShellWord[] = []
  for (const word of located) {
    const text = word.parts.find((part) => part.kind === 'literal')
    if (
      assignments.length + words.length === 0 &&
      text?.kind === 'literal' &&
      ENV_PREFIX_PATTERN.test(text.text)
    ) {
      assignments.push(word)
      continue
    }
    words.push(word)
  }

  const nodes: ShellSyntaxNode[] = [
    {
      kind: 'command',
      assignments,
      words,
      redirects: [],
      span,
    },
  ]
  const diagnostics = []
  let completeness: ParsedShellProgram['completeness'] = 'complete'
  if (UNPROJECTED_STRUCTURE.test(command)) {
    completeness = 'partial'
    diagnostics.push({ code: 'unsupported_node' as const, span })
    nodes.push({ kind: 'unsupported', upstreamKind: 'legacy_unprojected_structure', span })
  }

  return validateParsedProgram(
    {
      version: 1,
      sourceBytes,
      completeness,
      nodes,
      diagnostics,
    },
    command,
  )
}

export const legacyShellFrontend = {
  id: 'legacy-v1' as const,
  parse(command: string): Promise<ParsedShellProgram> {
    return Promise.resolve(parseLegacyShell(command))
  },
}

function partial(
  sourceBytes: number,
  code: ParsedShellProgram['diagnostics'][number]['code'],
  upstreamKind: string,
): ParsedShellProgram {
  const span = { startByte: 0, endByte: sourceBytes }
  return {
    version: 1,
    sourceBytes,
    completeness: 'partial',
    nodes: [{ kind: 'unsupported', upstreamKind, span }],
    diagnostics: [{ code, span }],
  }
}

function locateWords(command: string, tokens: readonly string[]): ShellWord[] | null {
  const bytes = Buffer.from(command, 'utf8')
  let cursor = 0
  const words: ShellWord[] = []
  for (const token of tokens) {
    const tokenBytes = Buffer.from(token, 'utf8')
    const index = bytes.indexOf(tokenBytes, cursor)
    if (index < 0) {
      return null
    }
    const span = { startByte: index, endByte: index + tokenBytes.length }
    words.push({
      parts: [{ kind: 'literal', text: token, span }],
      span,
    })
    cursor = span.endByte
  }
  return words
}
