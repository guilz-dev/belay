import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const MAX_RESOLVE_DEPTH = 8

export interface LauncherResolution {
  recipe: string | null
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

function npmScriptName(tokens: string[]): string | null {
  if (tokens[0] === 'npm' && tokens[1] === 'test') {
    return 'test'
  }
  if (tokens[0] === 'npm' && tokens[1] === 'run' && tokens[2]) {
    return tokens[2]
  }
  if (tokens[0] === 'pnpm' && tokens[1] === 'run' && tokens[2]) {
    return tokens[2]
  }
  if (tokens[0] === 'npm' && tokens[1] && tokens[1] !== 'run' && tokens[1] !== 'install') {
    return null
  }
  return null
}

function resolveNpmRecipe(cwd: string, repoRoot: string, scriptName: string): LauncherResolution {
  const packagePath = findPackageJson(cwd, repoRoot) ?? findPackageJson(cwd, cwd)
  if (!packagePath) {
    if (/deploy|publish|release|ship|prod/i.test(scriptName)) {
      return { recipe: null, opaque: true, reason: 'external_script' }
    }
    return { recipe: null, opaque: true, reason: 'package_json_missing' }
  }
  const pkg = readPackageJson(path.dirname(packagePath))
  const scripts = pkg?.scripts
  if (!scripts || typeof scripts !== 'object') {
    return { recipe: null, opaque: true, reason: 'package_scripts_missing' }
  }
  const recipe = (scripts as Record<string, string>)[scriptName]
  if (!recipe || typeof recipe !== 'string') {
    if (/deploy|publish|release|ship|prod/i.test(scriptName)) {
      return { recipe: null, opaque: true, reason: 'external_script' }
    }
    return { recipe: null, opaque: true, reason: 'npm_script_undefined' }
  }
  if (/\$\(/.test(recipe) || /\$\{/.test(recipe)) {
    return { recipe: null, opaque: true, reason: 'npm_script_dynamic' }
  }
  return { recipe: recipe.trim(), opaque: false, reason: 'npm_script_resolved' }
}

function parseMakefileRecipes(makefilePath: string): Map<string, string> {
  const recipes = new Map<string, string>()
  try {
    const content = readFileSync(makefilePath, 'utf8')
    const lines = content.split('\n')
    let currentTarget: string | null = null
    let recipeLines: string[] = []

    const flush = () => {
      if (currentTarget && recipeLines.length > 0) {
        recipes.set(currentTarget, recipeLines.join(' ').trim())
      }
      currentTarget = null
      recipeLines = []
    }

    for (const line of lines) {
      if (line.trim().startsWith('#')) {
        continue
      }
      const targetMatch = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line)
      if (targetMatch) {
        flush()
        currentTarget = targetMatch[1] ?? null
        const inline = line.slice(targetMatch[0].length).trim()
        if (inline && !inline.startsWith('#')) {
          recipeLines.push(inline)
        }
        continue
      }
      if (currentTarget && /^\t/.test(line)) {
        recipeLines.push(line.trim())
      }
    }
    flush()
  } catch {
    return recipes
  }
  return recipes
}

function resolveMakeRecipe(cwd: string, repoRoot: string, target: string): LauncherResolution {
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
    return { recipe: null, opaque: true, reason: 'unknown_local_effect' }
  }
  const recipes = parseMakefileRecipes(makefilePath)
  const recipe = recipes.get(target)
  if (!recipe) {
    return { recipe: null, opaque: true, reason: 'make_target_undefined' }
  }
  if (/\$\(/.test(recipe) || /\$\{/.test(recipe)) {
    return { recipe: null, opaque: true, reason: 'make_recipe_dynamic' }
  }
  return { recipe: recipe.trim(), opaque: false, reason: 'make_recipe_resolved' }
}

export function resolveLauncherRecipe(params: {
  tokens: string[]
  cwd: string
  repoRoot: string
  depth: number
}): LauncherResolution | null {
  if (params.depth >= MAX_RESOLVE_DEPTH) {
    return { recipe: null, opaque: true, reason: 'launcher_depth_exceeded' }
  }

  const tokens = params.tokens
  const scriptName = npmScriptName(tokens)
  if (scriptName) {
    return resolveNpmRecipe(params.cwd, params.repoRoot, scriptName)
  }

  if (tokens[0] === 'make' && tokens[1] && !tokens[1].startsWith('-')) {
    return resolveMakeRecipe(params.cwd, params.repoRoot, tokens[1])
  }

  return null
}

export function isRoutineLauncher(tokens: string[]): boolean {
  return (
    (tokens[0] === 'npm' && (tokens[1] === 'run' || tokens[1] === 'test')) ||
    tokens[0] === 'pnpm' ||
    tokens[0] === 'make'
  )
}
