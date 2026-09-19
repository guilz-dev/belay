import { SHELL_FRONTEND_MODES, type ShellFrontendMode } from './types.js'

export function normalizeShellFrontendMode(value: unknown): ShellFrontendMode {
  if (value === undefined) {
    return 'legacy'
  }
  if (isShellFrontendMode(value)) {
    return value
  }
  throw new Error('classifier.shellFrontendMode must be legacy, shadow, canary, or mvdan')
}

function isShellFrontendMode(value: unknown): value is ShellFrontendMode {
  return typeof value === 'string' && (SHELL_FRONTEND_MODES as readonly string[]).includes(value)
}
