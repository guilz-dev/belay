import path from 'node:path'

import { resolveMutationTarget, resolveWorkspaceRootMatch } from '../path-utils.js'
import { extractRedirectTargets, tokenizeShell } from '../shell-tokenizer.js'

function applyPatchTargets(patch: string): string[] {
  const targets: string[] = []
  for (const line of patch.split('\n')) {
    const match = line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/)
    if (match?.[1]) {
      targets.push(match[1])
      continue
    }
    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/)
    if (moveMatch?.[1]) {
      targets.push(moveMatch[1])
    }
  }
  return targets
}

function extractToolFilePath(payload: Record<string, unknown>): string | null {
  const toolInput = payload.tool_input
  if (!toolInput || typeof toolInput !== 'object') {
    return null
  }
  const input = toolInput as Record<string, unknown>
  for (const key of ['path', 'file_path', 'target_file', 'filePath']) {
    if (typeof input[key] === 'string') {
      return input[key]
    }
  }
  return null
}

function extractToolPatch(payload: Record<string, unknown>): string | null {
  const toolInput = payload.tool_input
  if (!toolInput || typeof toolInput !== 'object') {
    return null
  }
  const input = toolInput as Record<string, unknown>
  for (const key of ['patch', 'input', 'text']) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      return input[key] as string
    }
  }
  return null
}

function addOutsideRepoPath(
  paths: Set<string>,
  token: string,
  cwd: string,
  repoRoot: string,
  trustedWorkspaceRoots: string[] = [],
): void {
  const resolved = resolveMutationTarget(token, cwd)
  if (resolved && resolveWorkspaceRootMatch(repoRoot, trustedWorkspaceRoots, resolved) === null) {
    paths.add(resolved)
  }
}

export function collectOutsideRepoPaths(
  command: string,
  cwd: string,
  repoRoot: string,
  trustedWorkspaceRoots: string[] = [],
): string[] {
  const tokens = tokenizeShell(command)
  const redirects = extractRedirectTargets(tokens)
  const paths = new Set<string>()

  for (const token of tokens.slice(1)) {
    addOutsideRepoPath(paths, token, cwd, repoRoot, trustedWorkspaceRoots)
  }

  for (const redirect of redirects) {
    addOutsideRepoPath(paths, redirect, cwd, repoRoot, trustedWorkspaceRoots)
  }

  return [...paths]
}

export function collectOutsideRepoPathsFromToolPayload(
  payload: Record<string, unknown>,
  cwd: string,
  repoRoot: string,
  trustedWorkspaceRoots: string[] = [],
): string[] {
  const toolKind = String(payload.tool_name ?? '')
    .trim()
    .toLowerCase()
  const paths = new Set<string>()

  const filePath = extractToolFilePath(payload)
  if (filePath) {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
    if (resolveWorkspaceRootMatch(repoRoot, trustedWorkspaceRoots, resolved) === null) {
      paths.add(resolved)
    }
    return [...paths]
  }

  if (toolKind === 'apply_patch' || toolKind === 'applypatch') {
    const patch = extractToolPatch(payload)
    if (patch) {
      for (const target of applyPatchTargets(patch)) {
        const resolved = path.isAbsolute(target) ? target : path.resolve(cwd, target)
        if (resolveWorkspaceRootMatch(repoRoot, trustedWorkspaceRoots, resolved) === null) {
          paths.add(resolved)
        }
      }
    }
  }

  return [...paths]
}
