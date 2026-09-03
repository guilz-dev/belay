import type { ShellEffectRequirement } from '../../shell-build.js'
import { isOptionToken } from '../tokens.js'

export function decodeSetBuiltin(args: string[]): boolean {
  let index = 0
  while (index < args.length) {
    const arg = args[index] ?? ''
    if (arg === '--') {
      index += 1
      continue
    }
    if (arg === '-o' || arg === '+o') {
      if (!args[index + 1]) {
        return false
      }
      index += 2
      continue
    }
    if (/^[-+][A-Za-z0-9]+$/.test(arg)) {
      index += 1
      continue
    }
    return false
  }
  return true
}

export function decodeShellControlBuiltin(
  head: string,
  args: string[],
): ShellEffectRequirement[] | null {
  if (head === 'set') {
    return decodeSetBuiltin(args) ? [] : null
  }
  if (head === 'wait') {
    if (args.length === 0 || args.every((arg) => /^\d+$/.test(arg))) {
      return []
    }
    return null
  }
  if (head === 'exit') {
    if (args.length === 0 || (args.length === 1 && /^-?\d+$/.test(args[0] ?? ''))) {
      return []
    }
    return null
  }
  return null
}

export function validLsof(args: string[]): boolean {
  const flagsWithoutValues = new Set(['-a', '-b', '-l', '-n', '-P', '-R', '-t', '-V'])
  const flagsWithValues = new Set(['-c', '-d', '-F', '-g', '-p', '-T', '-u', '+d', '+D'])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (flagsWithoutValues.has(arg) || arg === '-i') {
      continue
    }
    if (flagsWithValues.has(arg)) {
      if (!args[index + 1] || isOptionToken(args[index + 1] ?? '')) {
        return false
      }
      index += 1
      continue
    }
    if (
      (/^-[ablnPRtV]+$/.test(arg) &&
        [...arg.slice(1)].every((flag) => 'ablnPRtV'.includes(flag))) ||
      /^-i(?:TCP|UDP)?(?::\d+(?:-\d+)?)?$/.test(arg) ||
      /^-s(?:TCP|UDP):[A-Za-z]+$/.test(arg) ||
      /^-(?:c|d|F|g|p|T|u).+$/.test(arg) ||
      /^\+(?:d|D).+$/.test(arg)
    ) {
      continue
    }
    return false
  }
  return true
}

export function validPs(args: string[]): boolean {
  const bareForms = new Set(['aux', 'ax', 'x', 'u'])
  const flagsWithoutValues = new Set(['-A', '-a', '-d', '-e', '-f', '-j', '-l', '-T', '-x'])
  const flagsWithValues = new Set([
    '--format',
    '--group',
    '--pid',
    '--ppid',
    '--sort',
    '--tty',
    '--user',
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (bareForms.has(arg) || flagsWithoutValues.has(arg)) {
      continue
    }
    if (flagsWithValues.has(arg)) {
      if (!args[index + 1] || isOptionToken(args[index + 1] ?? '')) {
        return false
      }
      index += 1
      continue
    }
    if (/^(?:--format|--group|--pid|--ppid|--sort|--tty|--user)=.+$/.test(arg)) {
      continue
    }
    if (/^-[^-]/.test(arg)) {
      const noValue = new Set(['A', 'a', 'd', 'e', 'f', 'j', 'l', 'T', 'x'])
      const withValue = new Set(['G', 'g', 'N', 'o', 'p', 't', 'U', 'u'])
      const characters = arg.slice(1)
      let valid = true
      for (let optionIndex = 0; optionIndex < characters.length; optionIndex += 1) {
        const option = characters[optionIndex] ?? ''
        if (noValue.has(option)) {
          continue
        }
        if (withValue.has(option)) {
          if (optionIndex === characters.length - 1) {
            if (!args[index + 1] || isOptionToken(args[index + 1] ?? '')) {
              return false
            }
            index += 1
          }
          break
        }
        valid = false
        break
      }
      if (valid) {
        continue
      }
    }
    return false
  }
  return true
}

export function validFilesystemTest(head: string, args: string[]): boolean {
  const operands = head === '[' && args.at(-1) === ']' ? args.slice(0, -1) : args
  if (head === '[' && args.at(-1) !== ']') {
    return false
  }
  return (
    operands.length === 2 &&
    new Set(['-b', '-c', '-d', '-e', '-f', '-h', '-L', '-r', '-s', '-w', '-x']).has(
      operands[0] ?? '',
    ) &&
    Boolean(operands[1])
  )
}

export function bashSyntaxTarget(args: string[]): string | null {
  let syntaxOnly = false
  let script: string | null = null
  const shortFlags = new Set('abefhkmnptuvxBCEHPT'.split(''))
  const longFlags = new Set([
    '--debugger',
    '--dump-po-strings',
    '--dump-strings',
    '--help',
    '--login',
    '--noediting',
    '--noprofile',
    '--norc',
    '--posix',
    '--restricted',
    '--verbose',
    '--version',
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '-c' || arg === '-lc') {
      return null
    }
    if (arg === '-O' || arg === '+O' || arg === '--rcfile' || arg === '--init-file') {
      if (!args[index + 1] || isOptionToken(args[index + 1] ?? '')) {
        return null
      }
      index += 1
      continue
    }
    if (
      (arg.startsWith('-O') && arg.length > 2) ||
      (arg.startsWith('+O') && arg.length > 2) ||
      (arg.startsWith('--rcfile=') && arg.length > '--rcfile='.length) ||
      (arg.startsWith('--init-file=') && arg.length > '--init-file='.length)
    ) {
      continue
    }
    if (longFlags.has(arg)) {
      continue
    }
    if (/^[+-][A-Za-z]+$/.test(arg)) {
      const options = arg.slice(1)
      if ([...options].some((option) => !shortFlags.has(option))) {
        return null
      }
      syntaxOnly ||= options.includes('n')
      continue
    }
    if (arg === '--') {
      script = args[index + 1] ?? null
      break
    }
    if (arg.startsWith('-') || arg.startsWith('+')) {
      return null
    }
    script = arg
    break
  }
  return syntaxOnly ? script : null
}
