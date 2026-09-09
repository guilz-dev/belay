import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { lexShell } from '../shell-tokenizer.js'
import {
  expandMakeExpression,
  normalizeMakeRecipeLine,
  parseMakefileVariables,
} from './makefile-expand.js'

const MAX_RESOLVE_DEPTH = 8
const PNPM_BUILTIN_COMMANDS = new Set([
  'add',
  'audit',
  'cache',
  'config',
  'deploy',
  'dlx',
  'exec',
  'fetch',
  'help',
  'import',
  'init',
  'install',
  'i',
  'licenses',
  'link',
  'list',
  'outdated',
  'pack',
  'patch',
  'patch-commit',
  'patch-remove',
  'publish',
  'prune',
  'rebuild',
  'remove',
  'rm',
  'store',
  'unlink',
  'update',
  'up',
  'why',
])

export interface LauncherResolution {
  recipes: string[]
  opaque: boolean
  reason: string
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  const packagePath = path.join(dir, 'package.json')
  if (!existsSync(packagePath)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function findPackageJson(startDir: string, stopDir: string): string | null {
  let current = path.resolve(startDir)
  const stop = path.resolve(stopDir)
  while (true) {
    const packagePath = path.join(current, 'package.json')
    if (existsSync(packagePath)) {
      return packagePath
    }
    if (current === stop || current === path.dirname(current)) {
      return existsSync(packagePath) ? packagePath : null
    }
    const parent = path.dirname(current)
    if (!parent.startsWith(stop) && parent !== current) {
      // still allow walking up until repo root parent
    }
    if (parent === current) {
      break
    }
    current = parent
  }
  return null
}

function launcherTokens(tokens: string[]): string[] {
  const dashIndex = tokens.indexOf('--')
  return dashIndex === -1 ? tokens : tokens.slice(0, dashIndex)
}

function forwardedArgs(tokens: string[]): string[] {
  const dashIndex = tokens.indexOf('--')
  if (dashIndex === -1) {
    return []
  }
  return tokens.slice(dashIndex + 1)
}

function npmScriptName(tokens: string[]): string | null {
  const launcher = launcherTokens(tokens)
  if (launcher[0] === 'npm' && launcher[1] === 'test') {
    return 'test'
  }
  if (launcher[0] === 'npm' && launcher[1] === 'run' && launcher[2]) {
    return launcher[2]
  }
  if (launcher[0] === 'pnpm' && launcher[1] === 'run' && launcher[2]) {
    return launcher[2]
  }
  if (launcher[0] === 'pnpm' && launcher[1] === 'test') {
    return 'test'
  }
  if (
    launcher[0] === 'pnpm' &&
    launcher[1] &&
    !launcher[1].startsWith('-') &&
    !PNPM_BUILTIN_COMMANDS.has(launcher[1])
  ) {
    return launcher[1]
  }
  if (launcher[0] === 'npm' && launcher[1] && launcher[1] !== 'run' && launcher[1] !== 'install') {
    return null
  }
  return null
}

function applyForwardedArgs(recipe: string, extra: string[]): string {
  if (extra.length === 0) {
    return recipe.trim()
  }
  return `${recipe.trim()} ${extra.join(' ')}`.trim()
}

function resolveNpmRecipe(
  cwd: string,
  repoRoot: string,
  scriptName: string,
  extraArgs: string[],
): LauncherResolution {
  const packagePath = findPackageJson(cwd, repoRoot) ?? findPackageJson(cwd, cwd)
  if (!packagePath) {
    if (/deploy|publish|release|ship|prod/i.test(scriptName)) {
      return { recipes: [], opaque: true, reason: 'external_script' }
    }
    return { recipes: [], opaque: true, reason: 'package_json_missing' }
  }
  const pkg = readPackageJson(path.dirname(packagePath))
  const scripts = pkg?.scripts
  if (!scripts || typeof scripts !== 'object') {
    return { recipes: [], opaque: true, reason: 'package_scripts_missing' }
  }
  const scriptMap = scripts as Record<string, unknown>
  const recipe = scriptMap[scriptName]
  if (!recipe || typeof recipe !== 'string') {
    if (/deploy|publish|release|ship|prod/i.test(scriptName)) {
      return { recipes: [], opaque: true, reason: 'external_script' }
    }
    return { recipes: [], opaque: true, reason: 'npm_script_undefined' }
  }
  const lifecycleRecipes = [
    scriptMap[`pre${scriptName}`],
    applyForwardedArgs(recipe, extraArgs),
    scriptMap[`post${scriptName}`],
  ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  if (lifecycleRecipes.some((entry) => /\$\(/.test(entry) || /\$\{/.test(entry))) {
    return { recipes: lifecycleRecipes, opaque: true, reason: 'npm_script_dynamic' }
  }
  return {
    recipes: lifecycleRecipes,
    opaque: false,
    reason: 'npm_script_resolved',
  }
}

interface MakeTarget {
  prerequisites: string[]
  recipes: string[]
  opaquePrerequisites: boolean
}

function hasRecipeContinuation(line: string): boolean {
  let trailingBackslashes = 0
  for (let index = line.length - 1; index >= 0 && line[index] === '\\'; index -= 1) {
    trailingBackslashes += 1
  }
  return trailingBackslashes % 2 === 1
}

function logicalMakeRecipeLines(lines: readonly string[]): string[] {
  const logical: string[] = []
  let current = ''
  for (const line of lines) {
    current = current ? `${current}\n${line}` : line
    if (hasRecipeContinuation(line)) {
      continue
    }
    logical.push(current)
    current = ''
  }
  if (current) {
    logical.push(current)
  }
  return logical
}

function hasBackgroundControl(recipe: string): boolean {
  return lexShell(recipe).tokens.some((token) => token.kind === 'operator' && token.value === '&')
}

const MAKE_GROUPABLE_SHORT_FLAGS_PATTERN = /^[bmBdehikLnpqrRsStvw]*$/
const MAKE_NO_OPERAND_LONG_FLAGS = new Set([
  '--always-make',
  '--check-symlink-times',
  '--debug',
  '--dry-run',
  '--environment-overrides',
  '--help',
  '--ignore-errors',
  '--just-print',
  '--keep-going',
  '--no-builtin-rules',
  '--no-builtin-variables',
  '--no-keep-going',
  '--no-print-directory',
  '--print-data-base',
  '--print-directory',
  '--question',
  '--quiet',
  '--recon',
  '--silent',
  '--stop',
  '--touch',
  '--version',
  '--warn-undefined-variables',
])

interface MakefileOperand {
  value: string | null
  consumesNext: boolean
}

interface MakefileOptions {
  explicit: boolean
  complete: boolean
  opaque: boolean
  sources: string[]
  operandIndexes: Set<number>
}

interface MakefileSnapshot {
  path: string
  content: string
}

function makefileOperand(token: string, nextToken: string | undefined): MakefileOperand | null {
  if (token === '--file' || token === '--makefile') {
    return { value: nextToken ?? null, consumesNext: true }
  }
  const longOption = /^--(?:file|makefile)=(.*)$/.exec(token)
  if (longOption) {
    return { value: longOption[1] ?? null, consumesNext: false }
  }
  if (!token.startsWith('-') || token.startsWith('--')) {
    return null
  }
  const options = token.slice(1)
  const fileOptionIndex = options.indexOf('f')
  if (
    fileOptionIndex === -1 ||
    !MAKE_GROUPABLE_SHORT_FLAGS_PATTERN.test(options.slice(0, fileOptionIndex))
  ) {
    return null
  }
  const attached = options.slice(fileOptionIndex + 1)
  return {
    value: attached || nextToken || null,
    consumesNext: attached.length === 0,
  }
}

function parseMakefileOptions(tokens: readonly string[]): MakefileOptions {
  const sources: string[] = []
  const operandIndexes = new Set<number>()
  let explicit = false
  let complete = true
  let opaque = false
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (token === '--') {
      break
    }
    const operand = makefileOperand(token, tokens[index + 1])
    if (!operand) {
      if (
        token.startsWith('-') &&
        !(
          token.length > 1 &&
          !token.startsWith('--') &&
          MAKE_GROUPABLE_SHORT_FLAGS_PATTERN.test(token.slice(1))
        ) &&
        !MAKE_NO_OPERAND_LONG_FLAGS.has(token)
      ) {
        opaque = true
      }
      continue
    }
    explicit = true
    if (operand.consumesNext && tokens[index + 1] !== undefined) {
      operandIndexes.add(index + 1)
      index += 1
    }
    if (!operand.value) {
      complete = false
      continue
    }
    sources.push(operand.value)
  }
  return { explicit, complete, opaque, sources, operandIndexes }
}

function readExplicitMakefile(source: string, cwd: string): MakefileSnapshot | null {
  if (source === '-' || /[$`*?[]/.test(source)) {
    return null
  }
  const resolved = path.resolve(cwd, source)
  try {
    if (!statSync(resolved).isFile()) {
      return null
    }
    return { path: resolved, content: readFileSync(resolved, 'utf8') }
  } catch {
    return null
  }
}

function parseMakefileRecipeContent(content: string): Map<string, MakeTarget> {
  const targets = new Map<string, MakeTarget>()
  try {
    const lines = content.split('\n')
    let currentTarget: string | null = null
    let recipeLines: string[] = []

    const flush = () => {
      if (currentTarget) {
        const current = targets.get(currentTarget) ?? {
          prerequisites: [],
          recipes: [],
          opaquePrerequisites: false,
        }
        targets.set(currentTarget, {
          prerequisites: current.prerequisites,
          recipes: logicalMakeRecipeLines(recipeLines)
            .map(normalizeMakeRecipeLine)
            .filter((line) => line.length > 0),
          opaquePrerequisites: current.opaquePrerequisites,
        })
      }
      currentTarget = null
      recipeLines = []
    }

    for (const line of lines) {
      if (line.trim().startsWith('#')) {
        continue
      }
      const targetMatch = /^([A-Za-z0-9_.-]+)\s*:(?!=)\s*([^#]*)/.exec(line)
      if (targetMatch) {
        flush()
        currentTarget = targetMatch[1] ?? null
        if (currentTarget) {
          const targetBody = (targetMatch[2] ?? '').trim()
          const inlineRecipeIndex = targetBody.indexOf(';')
          const prerequisiteText =
            inlineRecipeIndex >= 0 ? targetBody.slice(0, inlineRecipeIndex).trim() : targetBody
          const inlineRecipe =
            inlineRecipeIndex >= 0 ? targetBody.slice(inlineRecipeIndex + 1).trim() : ''
          const prerequisiteTokens = prerequisiteText
            .split(/\s+/)
            .filter((token) => token && token !== '|')
          targets.set(currentTarget, {
            prerequisites: prerequisiteTokens.filter(
              (token) => !token.includes('$(') && !token.includes('${'),
            ),
            recipes: [],
            opaquePrerequisites: prerequisiteTokens.some(
              (token) => token.includes('$(') || token.includes('${'),
            ),
          })
          if (inlineRecipe) {
            recipeLines.push(inlineRecipe)
          }
        }
        continue
      }
      if (currentTarget && /^\t/.test(line)) {
        recipeLines.push(line.slice(1).replace(/\r$/, ''))
      }
    }
    flush()
  } catch {
    return targets
  }
  return targets
}

function resolveMakeRecipe(
  cwd: string,
  repoRoot: string,
  target: string,
  cliVars: Readonly<Record<string, string>> = {},
  explicitMakefile?: MakefileSnapshot,
): LauncherResolution {
  const candidates = ['Makefile', 'makefile', 'GNUmakefile']
  let makefilePath: string | null = explicitMakefile?.path ?? null
  let searchDir = path.resolve(cwd)
  const stop = path.resolve(repoRoot)
  while (!makefilePath) {
    for (const name of candidates) {
      const candidate = path.join(searchDir, name)
      if (existsSync(candidate)) {
        makefilePath = candidate
        break
      }
    }
    if (makefilePath || searchDir === stop || searchDir === path.dirname(searchDir)) {
      break
    }
    searchDir = path.dirname(searchDir)
  }
  if (!makefilePath) {
    return { recipes: [], opaque: true, reason: 'unknown_local_effect' }
  }
  let makefileContent: string
  try {
    makefileContent = explicitMakefile?.content ?? readFileSync(makefilePath, 'utf8')
  } catch {
    return { recipes: [], opaque: true, reason: 'makefile_source_opaque' }
  }
  const makefileVars = parseMakefileVariables(makefileContent)
  const targets = parseMakefileRecipeContent(makefileContent)
  if (!targets.has(target)) {
    return { recipes: [], opaque: true, reason: 'make_target_undefined' }
  }
  const recipeLines: string[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  let hasDynamicPrerequisite = false
  let hasUndefinedPrerequisite = false
  let hasDependencyCycle = false
  const collect = (name: string): void => {
    if (visited.has(name)) {
      return
    }
    if (visiting.has(name)) {
      hasDependencyCycle = true
      return
    }
    const entry = targets.get(name)
    if (!entry) {
      if (!existsSync(path.resolve(path.dirname(makefilePath), name))) {
        hasUndefinedPrerequisite = true
      }
      return
    }
    visiting.add(name)
    hasDynamicPrerequisite ||= entry.opaquePrerequisites
    for (const prerequisite of entry.prerequisites) {
      collect(prerequisite)
    }
    recipeLines.push(...entry.recipes)
    visiting.delete(name)
    visited.add(name)
  }
  collect(target)
  const expandedRecipes: string[] = []
  for (const line of recipeLines) {
    const normalized = normalizeMakeRecipeLine(line)
    const expanded = expandMakeExpression(normalized, cliVars, makefileVars)
    if (expanded === null) {
      return { recipes: recipeLines, opaque: true, reason: 'make_recipe_dynamic' }
    }
    expandedRecipes.push(expanded)
  }
  for (const line of expandedRecipes) {
    if (/\$\(/.test(line) || /\$\{/.test(line)) {
      return { recipes: expandedRecipes, opaque: true, reason: 'make_recipe_dynamic' }
    }
  }
  if (expandedRecipes.some(hasBackgroundControl)) {
    return { recipes: expandedRecipes, opaque: true, reason: 'make_recipe_background' }
  }
  if (hasDependencyCycle) {
    return { recipes: expandedRecipes, opaque: true, reason: 'make_dependency_cycle' }
  }
  if (hasDynamicPrerequisite) {
    return { recipes: expandedRecipes, opaque: true, reason: 'make_prerequisite_dynamic' }
  }
  if (hasUndefinedPrerequisite) {
    return { recipes: expandedRecipes, opaque: true, reason: 'make_prerequisite_undefined' }
  }
  return { recipes: expandedRecipes, opaque: false, reason: 'make_recipe_resolved' }
}

export function resolveLauncherRecipe(params: {
  tokens: string[]
  cwd: string
  repoRoot: string
  depth: number
}): LauncherResolution | null {
  const tokens = params.tokens
  const scriptName = npmScriptName(tokens)
  if (scriptName) {
    if (params.depth >= MAX_RESOLVE_DEPTH) {
      return { recipes: [], opaque: true, reason: 'launcher_depth_exceeded' }
    }
    const resolution = resolveNpmRecipe(
      params.cwd,
      params.repoRoot,
      scriptName,
      forwardedArgs(tokens),
    )
    if (
      tokens[0] === 'pnpm' &&
      tokens[1] &&
      !PNPM_BUILTIN_COMMANDS.has(tokens[1]) &&
      resolution.reason === 'npm_script_undefined'
    ) {
      return {
        recipes: [tokens.slice(1).join(' ')],
        opaque: false,
        reason: 'pnpm_exec_shorthand',
      }
    }
    return resolution
  }

  if (tokens[0] === 'make') {
    if (params.depth >= MAX_RESOLVE_DEPTH) {
      return { recipes: [], opaque: true, reason: 'launcher_depth_exceeded' }
    }
    const makefileOptions = parseMakefileOptions(tokens)
    if (makefileOptions.opaque) {
      return { recipes: [], opaque: true, reason: 'make_option_opaque' }
    }
    let explicitMakefile: MakefileSnapshot | undefined
    if (makefileOptions.explicit) {
      if (!makefileOptions.complete || makefileOptions.sources.length !== 1) {
        return { recipes: [], opaque: true, reason: 'makefile_source_opaque' }
      }
      const source = makefileOptions.sources[0]
      const snapshot = source ? readExplicitMakefile(source, params.cwd) : null
      if (!snapshot) {
        return { recipes: [], opaque: true, reason: 'makefile_source_opaque' }
      }
      explicitMakefile = snapshot
    }
    if (tokens.includes('-n') || tokens.includes('--dry-run')) {
      return null
    }
    let target: string | null = null
    const cliVars: Record<string, string> = {}
    for (let index = 1; index < tokens.length; index += 1) {
      if (makefileOptions.operandIndexes.has(index)) {
        continue
      }
      const token = tokens[index] ?? ''
      if (token.startsWith('-')) {
        continue
      }
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token)
      if (assignment) {
        cliVars[assignment[1] ?? ''] = assignment[2] ?? ''
        continue
      }
      if (!target) {
        target = token
      }
    }
    if (target) {
      return resolveMakeRecipe(params.cwd, params.repoRoot, target, cliVars, explicitMakefile)
    }
  }

  if (tokens[0] === 'pnpm' && tokens[1] === 'exec' && tokens[2]) {
    return {
      recipes: [tokens.slice(2).join(' ')],
      opaque: false,
      reason: 'pnpm_exec',
    }
  }

  return null
}

const READ_ONLY_LAUNCHER_SUFFIXES = new Set(['--version', '-v', '--help', '-h'])

function isReadOnlyLauncherInvocation(tokens: string[]): boolean {
  const head = tokens[1]
  return Boolean(head && READ_ONLY_LAUNCHER_SUFFIXES.has(head))
}

export { isReadOnlyLauncherInvocation }

export function isRoutineLauncher(tokens: string[]): boolean {
  if ((tokens[0] === 'pnpm' || tokens[0] === 'npm') && isReadOnlyLauncherInvocation(tokens)) {
    return false
  }
  return (
    (tokens[0] === 'npm' && (tokens[1] === 'run' || tokens[1] === 'test')) ||
    tokens[0] === 'pnpm' ||
    tokens[0] === 'make'
  )
}
