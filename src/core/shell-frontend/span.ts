import {
  MAX_SHELL_AST_DEPTH,
  MAX_SHELL_AST_NODES,
  type ParsedShellProgram,
  type ShellParseDiagnostic,
  type ShellSourceSpan,
  type ShellSyntaxNode,
} from './types.js'

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export function isUtf8Boundary(text: string, byteOffset: number): boolean {
  const byteLength = utf8ByteLength(text)
  if (byteOffset < 0 || byteOffset > byteLength) {
    return false
  }
  if (byteOffset === 0 || byteOffset === byteLength) {
    return true
  }
  const bytes = Buffer.from(text, 'utf8')
  let index = 0
  while (index < bytes.length) {
    if (index === byteOffset) {
      return true
    }
    if (index > byteOffset) {
      return false
    }
    index += utf8SequenceLength(bytes[index] ?? 0)
  }
  return index === byteOffset
}

export function validateParsedProgram(
  program: ParsedShellProgram,
  source: string,
): ParsedShellProgram {
  const diagnostics = [...program.diagnostics]
  let completeness = program.completeness
  const mark = (code: ShellParseDiagnostic['code'], span?: ShellSourceSpan) => {
    completeness = 'partial'
    diagnostics.push(span ? { code, span } : { code })
  }

  const seen = new Set<string>()
  const walk = (node: ShellSyntaxNode, depth: number, parent?: ShellSourceSpan) => {
    if (depth > MAX_SHELL_AST_DEPTH) {
      mark('depth_limit', node.span)
    }
    if (!spanInBounds(node.span, program.sourceBytes, source)) {
      mark('invalid_span', node.span)
    }
    if (parent && !spanWithin(node.span, parent)) {
      mark('invalid_span', node.span)
    }
    const children = childNodes(node)
    let previousEnd = node.span.startByte
    for (const child of children) {
      if (child.span.startByte < previousEnd) {
        mark('invalid_span', child.span)
      }
      previousEnd = Math.max(previousEnd, child.span.endByte)
      walk(child, depth + 1, node.span)
    }
    if (node.kind === 'command') {
      const words = [
        ...node.assignments,
        ...node.words,
        ...node.redirects.map((redirect) => redirect.target),
      ]
      for (const word of words) {
        if (!word) {
          continue
        }
        if (
          !spanWithin(word.span, node.span) ||
          !spanInBounds(word.span, program.sourceBytes, source)
        ) {
          mark('invalid_span', word.span)
        }
      }
    }
  }

  let count = 0
  const countWalk = (node: ShellSyntaxNode) => {
    count += 1
    for (const child of childNodes(node)) {
      countWalk(child)
    }
  }
  for (const node of program.nodes) {
    countWalk(node)
    walk(node, 1)
  }
  if (count > MAX_SHELL_AST_NODES) {
    mark('node_limit')
  }

  const unique = diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.code,
      diagnostic.span?.startByte ?? '',
      diagnostic.span?.endByte ?? '',
    ].join(':')
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })

  return {
    ...program,
    completeness,
    diagnostics: unique,
  }
}

function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) {
    return 1
  }
  if ((lead & 0xe0) === 0xc0) {
    return 2
  }
  if ((lead & 0xf0) === 0xe0) {
    return 3
  }
  if ((lead & 0xf8) === 0xf0) {
    return 4
  }
  return 1
}

function spanInBounds(span: ShellSourceSpan, sourceBytes: number, source: string): boolean {
  return (
    span.startByte >= 0 &&
    span.endByte >= span.startByte &&
    span.endByte <= sourceBytes &&
    isUtf8Boundary(source, span.startByte) &&
    isUtf8Boundary(source, span.endByte)
  )
}

function spanWithin(inner: ShellSourceSpan, outer: ShellSourceSpan): boolean {
  return inner.startByte >= outer.startByte && inner.endByte <= outer.endByte
}

function childNodes(node: ShellSyntaxNode): readonly ShellSyntaxNode[] {
  switch (node.kind) {
    case 'pipeline':
    case 'sequence':
    case 'subshell':
    case 'brace_group':
    case 'if':
    case 'loop':
    case 'case':
    case 'function':
    case 'command_substitution':
    case 'process_substitution':
      return node.children
    case 'and_or':
      return [node.left, node.right]
    case 'command':
    case 'unsupported':
      return []
    default: {
      const unreachable: never = node
      return unreachable
    }
  }
}
