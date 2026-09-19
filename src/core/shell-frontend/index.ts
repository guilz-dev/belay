export { authorizationProjectionsEqual, projectAuthorization } from './compare.js'
export { legacyShellFrontend, parseLegacyShell } from './legacy-frontend.js'
export { normalizeShellFrontendMode } from './mode.js'
export { mvdanShellFrontend, parseMvdanShell } from './mvdan-frontend.js'
export { routeShellFrontend, selectCanonicalEffectPlan } from './router.js'
export { validateParsedProgram } from './span.js'
export {
  MAX_SHELL_AST_DEPTH,
  MAX_SHELL_AST_NODES,
  type ParsedShellProgram,
  SHELL_FRONTEND_MODES,
  SHELL_PARSER_BUDGET_MS,
  type ShellFrontend,
  type ShellFrontendId,
  type ShellFrontendMode,
  type ShellSyntaxNode,
} from './types.js'
