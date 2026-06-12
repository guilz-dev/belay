import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
const MAX_RESOLVE_DEPTH = 8;
function readPackageJson(dir) {
    const packagePath = path.join(dir, 'package.json');
    if (!existsSync(packagePath)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(packagePath, 'utf8'));
    }
    catch {
        return null;
    }
}
function findPackageJson(startDir, stopDir) {
    let current = path.resolve(startDir);
    const stop = path.resolve(stopDir);
    while (true) {
        const packagePath = path.join(current, 'package.json');
        if (existsSync(packagePath)) {
            return packagePath;
        }
        if (current === stop || current === path.dirname(current)) {
            return existsSync(packagePath) ? packagePath : null;
        }
        const parent = path.dirname(current);
        if (!parent.startsWith(stop) && parent !== current) {
            // still allow walking up until repo root parent
        }
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return null;
}
function launcherTokens(tokens) {
    const dashIndex = tokens.indexOf('--');
    return dashIndex === -1 ? tokens : tokens.slice(0, dashIndex);
}
function forwardedArgs(tokens) {
    const dashIndex = tokens.indexOf('--');
    if (dashIndex === -1) {
        return [];
    }
    return tokens.slice(dashIndex + 1);
}
function npmScriptName(tokens) {
    const launcher = launcherTokens(tokens);
    if (launcher[0] === 'npm' && launcher[1] === 'test') {
        return 'test';
    }
    if (launcher[0] === 'npm' && launcher[1] === 'run' && launcher[2]) {
        return launcher[2];
    }
    if (launcher[0] === 'pnpm' && launcher[1] === 'run' && launcher[2]) {
        return launcher[2];
    }
    if (launcher[0] === 'npm' && launcher[1] && launcher[1] !== 'run' && launcher[1] !== 'install') {
        return null;
    }
    return null;
}
function applyForwardedArgs(recipe, extra) {
    if (extra.length === 0) {
        return recipe.trim();
    }
    return `${recipe.trim()} ${extra.join(' ')}`.trim();
}
function resolveNpmRecipe(cwd, repoRoot, scriptName, extraArgs) {
    const packagePath = findPackageJson(cwd, repoRoot) ?? findPackageJson(cwd, cwd);
    if (!packagePath) {
        if (/deploy|publish|release|ship|prod/i.test(scriptName)) {
            return { recipes: [], opaque: true, reason: 'external_script' };
        }
        return { recipes: [], opaque: true, reason: 'package_json_missing' };
    }
    const pkg = readPackageJson(path.dirname(packagePath));
    const scripts = pkg?.scripts;
    if (!scripts || typeof scripts !== 'object') {
        return { recipes: [], opaque: true, reason: 'package_scripts_missing' };
    }
    const recipe = scripts[scriptName];
    if (!recipe || typeof recipe !== 'string') {
        if (/deploy|publish|release|ship|prod/i.test(scriptName)) {
            return { recipes: [], opaque: true, reason: 'external_script' };
        }
        return { recipes: [], opaque: true, reason: 'npm_script_undefined' };
    }
    if (/\$\(/.test(recipe) || /\$\{/.test(recipe)) {
        return { recipes: [], opaque: true, reason: 'npm_script_dynamic' };
    }
    return {
        recipes: [applyForwardedArgs(recipe, extraArgs)],
        opaque: false,
        reason: 'npm_script_resolved',
    };
}
function parseMakefileRecipes(makefilePath) {
    const recipes = new Map();
    try {
        const content = readFileSync(makefilePath, 'utf8');
        const lines = content.split('\n');
        let currentTarget = null;
        let recipeLines = [];
        const flush = () => {
            if (currentTarget && recipeLines.length > 0) {
                recipes.set(currentTarget, recipeLines.map((line) => line.trim()).filter((line) => line.length > 0));
            }
            currentTarget = null;
            recipeLines = [];
        };
        for (const line of lines) {
            if (line.trim().startsWith('#')) {
                continue;
            }
            const targetMatch = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
            if (targetMatch) {
                flush();
                currentTarget = targetMatch[1] ?? null;
                const inline = line.slice(targetMatch[0].length).trim();
                if (inline && !inline.startsWith('#')) {
                    recipeLines.push(inline);
                }
                continue;
            }
            if (currentTarget && /^\t/.test(line)) {
                recipeLines.push(line.trim());
            }
        }
        flush();
    }
    catch {
        return recipes;
    }
    return recipes;
}
function resolveMakeRecipe(cwd, repoRoot, target) {
    const candidates = ['Makefile', 'makefile', 'GNUmakefile'];
    let makefilePath = null;
    let searchDir = path.resolve(cwd);
    const stop = path.resolve(repoRoot);
    while (true) {
        for (const name of candidates) {
            const candidate = path.join(searchDir, name);
            if (existsSync(candidate)) {
                makefilePath = candidate;
                break;
            }
        }
        if (makefilePath || searchDir === stop || searchDir === path.dirname(searchDir)) {
            break;
        }
        searchDir = path.dirname(searchDir);
    }
    if (!makefilePath) {
        return { recipes: [], opaque: true, reason: 'unknown_local_effect' };
    }
    const recipes = parseMakefileRecipes(makefilePath);
    const recipeLines = recipes.get(target);
    if (!recipeLines || recipeLines.length === 0) {
        return { recipes: [], opaque: true, reason: 'make_target_undefined' };
    }
    for (const line of recipeLines) {
        if (/\$\(/.test(line) || /\$\{/.test(line)) {
            return { recipes: [], opaque: true, reason: 'make_recipe_dynamic' };
        }
    }
    return { recipes: recipeLines, opaque: false, reason: 'make_recipe_resolved' };
}
export function resolveLauncherRecipe(params) {
    if (params.depth >= MAX_RESOLVE_DEPTH) {
        return { recipes: [], opaque: true, reason: 'launcher_depth_exceeded' };
    }
    const tokens = params.tokens;
    const scriptName = npmScriptName(tokens);
    if (scriptName) {
        return resolveNpmRecipe(params.cwd, params.repoRoot, scriptName, forwardedArgs(tokens));
    }
    if (tokens[0] === 'make' && tokens[1] && !tokens[1].startsWith('-')) {
        return resolveMakeRecipe(params.cwd, params.repoRoot, tokens[1]);
    }
    return null;
}
export function isRoutineLauncher(tokens) {
    return ((tokens[0] === 'npm' && (tokens[1] === 'run' || tokens[1] === 'test')) ||
        tokens[0] === 'pnpm' ||
        tokens[0] === 'make');
}
