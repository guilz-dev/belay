export interface ArgvDelegatePeelResult {
  launcher: string
  innerTokens: string[]
  opaque: boolean
  reason: string
  signals: string[]
}

export function innerRecipeFromArgvDelegate(peel: ArgvDelegatePeelResult): string | null {
  if (peel.opaque || peel.innerTokens.length === 0) {
    return null
  }
  return peel.innerTokens.join(' ')
}

export function peelArgvDelegateArgv(tokens: string[]): ArgvDelegatePeelResult | null {
  const launcher = tokens[0] ?? ''
  if (!launcher || tokens.length < 2) {
    return null
  }

  const signals: string[] = ['process.argv_delegate']
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (token === '--') {
      index += 1
      break
    }
    if (token.startsWith('-')) {
      return {
        launcher,
        innerTokens: [],
        opaque: true,
        reason: 'argv_delegate_wrapper_options',
        signals: [...signals, 'argv_delegate_wrapper_options'],
      }
    }
    break
  }

  const innerTokens = tokens.slice(index)
  if (innerTokens.length === 0) {
    return null
  }

  return {
    launcher,
    innerTokens,
    opaque: false,
    reason: 'argv_delegate_peel',
    signals,
  }
}
