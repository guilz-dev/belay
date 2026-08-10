import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import { pathWithinRoot } from '../path-utils.js'
import type { PackageExecLauncher } from './types.js'

export interface PackageExecPeelResult {
  launcher: PackageExecLauncher
  innerTokens: string[]
  acquisitionSpecs: string[]
  opaque: boolean
  reason: string
  forceAcquire: boolean
  signals: string[]
}

const READ_ONLY_SUFFIXES = new Set(['--version', '-v', '--help', '-h'])

function isPackageExecHead(head: string): head is PackageExecLauncher {
  return head === 'npx' || head === 'npm' || head === 'pnpm'
}

export function isPackageExecLauncher(tokens: string[]): boolean {
  const head = tokens[0] ?? ''
  if (head === 'npx') {
    return true
  }
  if (head === 'npm' && tokens[1] === 'exec') {
    return true
  }
  if (head === 'pnpm' && tokens[1] === 'dlx') {
    return true
  }
  return false
}

export function peelPackageExecArgv(tokens: string[]): PackageExecPeelResult | null {
  const head = tokens[0] ?? ''
  if (head === 'npx') {
    return peelNpx(tokens)
  }
  if (head === 'npm' && tokens[1] === 'exec') {
    return peelNpmExec(tokens)
  }
  if (head === 'pnpm' && tokens[1] === 'dlx') {
    return peelPnpmDlx(tokens)
  }
  return null
}

function peelNpx(tokens: string[]): PackageExecPeelResult {
  const signals: string[] = ['package_exec:npx']
  const acquisitionSpecs: string[] = []
  let index = 1
  let forceAcquire = false
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (index === 1 && tokens.length === 2 && READ_ONLY_SUFFIXES.has(token)) {
      return {
        launcher: 'npx',
        innerTokens: [token],
        acquisitionSpecs,
        opaque: false,
        reason: 'npx_wrapper_readonly',
        forceAcquire: false,
        signals: [...signals, 'npx_wrapper_readonly'],
      }
    }
    if (token === '--') {
      index += 1
      break
    }
    if (token === '-y' || token === '--yes') {
      forceAcquire = true
      signals.push('npx.force_yes')
      index += 1
      continue
    }
    if (token === '-p' || token === '--package') {
      if (!tokens[index + 1]) {
        return opaquePackageExec('npx', 'npx_package_missing', signals, acquisitionSpecs)
      }
      acquisitionSpecs.push(tokens[index + 1]!)
      forceAcquire = true
      signals.push('npx.package_flag')
      index += 2
      continue
    }
    if (token.startsWith('--package=')) {
      acquisitionSpecs.push(token.slice('--package='.length))
      forceAcquire = true
      signals.push('npx.package_flag')
      index += 1
      continue
    }
    if (token === '-c' || token === '--call') {
      return {
        launcher: 'npx',
        innerTokens: [],
        acquisitionSpecs,
        opaque: true,
        reason: 'npx_call_script',
        forceAcquire: true,
        signals: [...signals, 'npx_call_script'],
      }
    }
    if (token.startsWith('-')) {
      return opaquePackageExec(
        'npx',
        'npx_unknown_option',
        [...signals, 'npx_unknown_option'],
        acquisitionSpecs,
      )
    }
    break
  }
  const innerTokens = tokens.slice(index)
  if (innerTokens.length === 0) {
    return {
      launcher: 'npx',
      innerTokens: [],
      acquisitionSpecs,
      opaque: true,
      reason: 'npx_target_missing',
      forceAcquire,
      signals: [...signals, 'npx_target_missing'],
    }
  }
  if (/^@[^/]+\/[^/]+/.test(innerTokens[0] ?? '')) {
    return opaquePackageExec(
      'npx',
      'npx_scoped_package_bin_indeterminate',
      [...signals, 'npx_scoped_package_bin_indeterminate'],
      acquisitionSpecs,
    )
  }
  if (looksLikeRemotePackageSpec(innerTokens[0] ?? '')) {
    forceAcquire = true
    signals.push('npx.remote_spec')
  }
  if (acquisitionSpecs.length === 0 && innerTokens[0]) {
    acquisitionSpecs.push(innerTokens[0])
  }
  return {
    launcher: 'npx',
    innerTokens,
    acquisitionSpecs,
    opaque: false,
    reason: 'npx_exec',
    forceAcquire,
    signals,
  }
}

function peelNpmExec(tokens: string[]): PackageExecPeelResult {
  return peelForcedPackageExec(tokens, 2, 'npm', 'npm_exec')
}

function peelPnpmDlx(tokens: string[]): PackageExecPeelResult {
  return peelForcedPackageExec(tokens, 2, 'pnpm', 'pnpm_dlx')
}

function peelForcedPackageExec(
  tokens: string[],
  startIndex: number,
  launcher: PackageExecLauncher,
  reason: 'npm_exec' | 'pnpm_dlx',
): PackageExecPeelResult {
  const signals = [`package_exec:${reason}`, `${reason}_acquire`]
  const acquisitionSpecs: string[] = []
  let index = startIndex
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (token === '--') {
      index += 1
      break
    }
    if (launcher === 'npm' && (token === '-y' || token === '--yes')) {
      index += 1
      continue
    }
    if (launcher === 'npm' && (token === '-p' || token === '--package')) {
      if (!tokens[index + 1]) {
        return opaquePackageExec(launcher, `${reason}_package_missing`, signals, acquisitionSpecs)
      }
      acquisitionSpecs.push(tokens[index + 1]!)
      index += 2
      continue
    }
    if (launcher === 'npm' && token.startsWith('--package=')) {
      acquisitionSpecs.push(token.slice('--package='.length))
      index += 1
      continue
    }
    if (launcher === 'npm' && (token === '-c' || token === '--call')) {
      return opaquePackageExec(launcher, `${reason}_call_script`, signals, acquisitionSpecs)
    }
    if (token.startsWith('-')) {
      return opaquePackageExec(
        launcher,
        `${reason}_unknown_option`,
        [...signals, `${reason}_unknown_option`],
        acquisitionSpecs,
      )
    }
    break
  }
  const innerTokens = tokens.slice(index)
  if (acquisitionSpecs.length === 0 && innerTokens[0]) {
    acquisitionSpecs.push(innerTokens[0])
  }
  return {
    launcher,
    innerTokens,
    acquisitionSpecs,
    opaque: innerTokens.length === 0,
    reason: innerTokens.length === 0 ? `${reason}_missing` : reason,
    forceAcquire: true,
    signals,
  }
}

function opaquePackageExec(
  launcher: PackageExecLauncher,
  reason: string,
  signals: string[],
  acquisitionSpecs: string[] = [],
): PackageExecPeelResult {
  return {
    launcher,
    innerTokens: [],
    acquisitionSpecs,
    opaque: true,
    reason,
    forceAcquire: true,
    signals,
  }
}

function looksLikeRemotePackageSpec(token: string): boolean {
  if (!token || token.startsWith('-')) {
    return false
  }
  if (token.includes('@') && !token.startsWith('@')) {
    return true
  }
  if (/^@[^/]+\/[^/]+@/.test(token)) {
    return true
  }
  if (/^(https?:|git\+|github:|gitlab:)/.test(token)) {
    return true
  }
  return false
}

export function resolveLocalBin(
  binName: string,
  cwd: string,
  repoRoot: string,
): { path: string; proven: true } | null {
  const base = path.basename(binName)
  if (!base || base === '.' || base === '..') {
    return null
  }
  let current = path.resolve(cwd)
  const stop = path.resolve(repoRoot)
  if (!pathWithinRoot(stop, current)) {
    return null
  }
  while (true) {
    const candidate = path.join(current, 'node_modules', '.bin', base)
    if (existsSync(candidate)) {
      try {
        const resolvedCandidate = realpathSync.native(candidate)
        if (!pathWithinRoot(stop, resolvedCandidate) || !statSync(resolvedCandidate).isFile()) {
          return null
        }
        return { path: resolvedCandidate, proven: true }
      } catch {
        return null
      }
    }
    if (current === stop) {
      break
    }
    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return null
}

export function innerRecipeFromPeel(peel: PackageExecPeelResult): string | null {
  if (peel.opaque || peel.reason === 'npx_wrapper_readonly' || peel.innerTokens.length === 0) {
    return null
  }
  return peel.innerTokens.join(' ')
}

export function isPackageExecHeadToken(head: string): boolean {
  return isPackageExecHead(head)
}
