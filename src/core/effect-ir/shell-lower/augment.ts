import { isFdDuplication, isRedirectOperator } from '../../shell-tokenizer.js'
import type { ShellEffectRequirement } from '../shell-build.js'
import type { LowerContext } from './context.js'
import { addSecretRead, addWriteEffects, requirement } from './requirement.js'
import { expandKnownVariables, resolvePathOperand } from './tokens.js'

export function addRedirectEffects(
  requirements: ShellEffectRequirement[],
  tokens: string[],
  env: Readonly<Record<string, string | undefined>>,
  context: LowerContext,
  segment: string,
): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const operator = tokens[index] ?? ''
    if (!isRedirectOperator(operator) || isFdDuplication(operator)) {
      continue
    }
    const rawTarget = tokens[index + 1]
    if (!rawTarget) {
      requirements.push(
        requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
          'shell.redirect_target_missing',
        ]),
      )
      continue
    }
    if (operator.includes('<<')) {
      requirements.push(
        requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
          'shell.heredoc_opaque',
        ]),
      )
      index += 1
      continue
    }
    const target = expandKnownVariables(rawTarget, env)
    const resolved = resolvePathOperand(target, context.cwd)
    if (resolved === '/dev/null') {
      index += 1
      continue
    }
    if (operator.includes('<')) {
      requirements.push(
        requirement('fs.read', 'fs.read', { kind: 'path', path: resolved }, segment, [
          'shell.input_redirect',
        ]),
      )
      addSecretRead(requirements, resolved, segment)
    }
    if (operator.includes('>')) {
      addWriteEffects(requirements, resolved, segment, ['shell.output_redirect'])
    }
    index += 1
  }
}

export function effectChangingEnvironmentSignals(
  head: string,
  env: Readonly<Record<string, string | undefined>>,
  changedNames: ReadonlySet<string>,
): string[] {
  if (
    head === 'curl' &&
    (env.CURL_HOME ||
      changedNames.has('CURL_HOME') ||
      changedNames.has('HOME') ||
      changedNames.has('XDG_CONFIG_HOME'))
  ) {
    return ['egress.curl.environment_config_override']
  }
  if (head === 'wget' && (env.WGETRC || changedNames.has('WGETRC') || changedNames.has('HOME'))) {
    return ['egress.wget.environment_config_override']
  }
  if (head !== 'git') {
    return []
  }
  const hazardousNames = new Set([
    'GIT_ASKPASS',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_CONFIG',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_DIR',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_EDITOR',
    'GIT_EXEC_PATH',
    'GIT_EXTERNAL_DIFF',
    'GIT_INDEX_FILE',
    'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PAGER',
    'GIT_PROXY_COMMAND',
    'GIT_QUARANTINE_PATH',
    'GIT_SEQUENCE_EDITOR',
    'GIT_SHALLOW_FILE',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_TEMPLATE_DIR',
    'GIT_WORK_TREE',
    'SSH_ASKPASS',
  ])
  const overridden =
    changedNames.has('HOME') ||
    changedNames.has('XDG_CONFIG_HOME') ||
    Object.entries(env).some(([name, value]) => {
      if (!value) {
        return false
      }
      if (
        hazardousNames.has(name) ||
        /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name) ||
        /^GIT_TRACE/.test(name)
      ) {
        return true
      }
      return name === 'GIT_CONFIG_COUNT' && value !== '0'
    })
  return overridden ? ['git.environment_execution_or_config_override'] : []
}
