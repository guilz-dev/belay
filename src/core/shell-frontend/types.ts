export const SHELL_FRONTEND_CONTRACT_VERSION = 1 as const

export const MAX_SHELL_AST_NODES = 10_000
export const MAX_SHELL_AST_DEPTH = 128
export const SHELL_PARSER_BUDGET_MS = 250

export type ShellFrontendId = 'legacy-v1' | 'mvdan-v1'

export type ShellFrontendMode = 'legacy' | 'shadow' | 'canary' | 'mvdan'

export const SHELL_FRONTEND_MODES = ['legacy', 'shadow', 'canary', 'mvdan'] as const

export interface ShellFrontend {
  readonly id: ShellFrontendId
  parse(command: string): Promise<ParsedShellProgram>
}

export interface ParsedShellProgram {
  version: typeof SHELL_FRONTEND_CONTRACT_VERSION
  sourceBytes: number
  completeness: 'complete' | 'partial'
  nodes: readonly ShellSyntaxNode[]
  diagnostics: readonly ShellParseDiagnostic[]
}

export interface ShellSourceSpan {
  startByte: number
  endByte: number
}

export type ShellParseDiagnosticCode =
  | 'invalid_syntax'
  | 'unsupported_node'
  | 'invalid_span'
  | 'node_limit'
  | 'depth_limit'
  | 'parser_timeout'
  | 'artifact_unavailable'
  | 'artifact_mismatch'
  | 'bridge_protocol_error'

export interface ShellParseDiagnostic {
  code: ShellParseDiagnosticCode
  span?: ShellSourceSpan
}

export type ShellWordPart =
  | { kind: 'literal'; text: string; span: ShellSourceSpan }
  | { kind: 'quoted'; text: string; span: ShellSourceSpan }
  | { kind: 'parameter_expansion'; span: ShellSourceSpan }
  | { kind: 'arithmetic_expansion'; span: ShellSourceSpan }
  | { kind: 'substitution'; span: ShellSourceSpan }

export interface ShellWord {
  parts: readonly ShellWordPart[]
  span: ShellSourceSpan
}

export interface ShellRedirect {
  fd?: number
  operator: string
  target?: ShellWord
  heredoc?: { delimiter: string; expands: boolean }
  span: ShellSourceSpan
}

export type ShellSyntaxNode =
  | {
      kind: 'command'
      assignments: readonly ShellWord[]
      words: readonly ShellWord[]
      redirects: readonly ShellRedirect[]
      span: ShellSourceSpan
    }
  | {
      kind: 'pipeline'
      negated: boolean
      children: readonly ShellSyntaxNode[]
      span: ShellSourceSpan
    }
  | {
      kind: 'and_or'
      operator: '&&' | '||'
      left: ShellSyntaxNode
      right: ShellSyntaxNode
      span: ShellSourceSpan
    }
  | {
      kind: 'sequence'
      children: readonly ShellSyntaxNode[]
      span: ShellSourceSpan
    }
  | {
      kind: 'subshell'
      children: readonly ShellSyntaxNode[]
      span: ShellSourceSpan
    }
  | {
      kind: 'brace_group'
      children: readonly ShellSyntaxNode[]
      span: ShellSourceSpan
    }
  | {
      kind: 'if' | 'loop' | 'case' | 'function'
      children: readonly ShellSyntaxNode[]
      span: ShellSourceSpan
    }
  | {
      kind: 'command_substitution' | 'process_substitution'
      children: readonly ShellSyntaxNode[]
      span: ShellSourceSpan
    }
  | {
      kind: 'unsupported'
      upstreamKind: string
      span: ShellSourceSpan
    }
