import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  expandMakeExpression,
  normalizeMakeRecipeLine,
  parseMakefileVariables,
  parsePhonyTargets,
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
          recipes: recipeLines.map((line) => line.trim()).filter((line) => line.length > 0),
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
        recipeLines.push(line.trim())
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
): LauncherResolution {
  const candidates = ['Makefile', 'makefile', 'GNUmakefile']
  let makefilePath: string | null = null
  let searchDir = path.resolve(cwd)
  const stop = path.resolve(repoRoot)
  while (true) {
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
  const makefileContent = readFileSync(makefilePath, 'utf8')
  const makefileVars = parseMakefileVariables(makefileContent)
  const phonyTargets = parsePhonyTargets(makefileContent)
  const targets = parseMakefileRecipeContent(makefileContent)
  if (!targets.has(target)) {
    return { recipes: [], opaque: true, reason: 'make_target_undefined' }
  }
  const recipeLines: string[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  let opaquePrerequisites = false
  const collect = (name: string): boolean => {
    if (visited.has(name)) {
      return true
    }
    if (visiting.has(name)) {
      return false
    }
    const entry = targets.get(name)
    if (!entry) {
      return true
    }
    visiting.add(name)
    opaquePrerequisites ||= entry.opaquePrerequisites
    for (const prerequisite of entry.prerequisites) {
      if (targets.has(prerequisite) && !collect(prerequisite)) {
        return false
      }
    }
    // When the requested target has its own recipes, treat those as the
    // authorization authority. Skip .PHONY / `_`-prefixed prerequisite
    // recipes (e.g. `_start_test_deps` docker-compose up) so setup-only
    // side effects do not obscure the target's direct command.
    const skipPhonyPrerequisiteRecipes =
      name !== target &&
      (phonyTargets.has(name) || name.startsWith('_')) &&
      (targets.get(target)?.recipes.length ?? 0) > 0
    if (!skipPhonyPrerequisiteRecipes) {
      recipeLines.push(...entry.recipes)
    }
    visiting.delete(name)
    visited.add(name)
    return true
  }
  if (!collect(target)) {
    return { recipes: recipeLines, opaque: true, reason: 'make_dependency_cycle' }
  }
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
  if (opaquePrerequisites) {
    return { recipes: expandedRecipes, opaque: true, reason: 'make_prerequisite_dynamic' }
  }
  return { recipes: expandedRecipes, opaque: false, reason: 'make_recipe_resolved' }
}

export function resolveLauncherRecipe(params: {
  tokens: string[]
  cwd: string
  repoRoot: string
  depth: number
}): LauncherResolution | null {
  if (params.depth >= MAX_RESOLVE_DEPTH) {
    return { recipes: [], opaque: true, reason: 'launcher_depth_exceeded' }
  }

  const tokens = params.tokens
  const scriptName = npmScriptName(tokens)
  if (scriptName) {
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
    if (tokens.includes('-n') || tokens.includes('--dry-run')) {
      return null
    }
    let target: string | null = null
    const cliVars: Record<string, string> = {}
    for (const token of tokens.slice(1)) {
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
      return resolveMakeRecipe(params.cwd, params.repoRoot, target, cliVars)
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
