import { describe, expect, it } from 'vitest'

import { lexShell } from '../../core/shell-tokenizer.js'
import { decodeRecursiveInvocation } from '../../core/verdict/recursive-invocation.js'

describe('decodeRecursiveInvocation', () => {
  it.each([
    [`bash -ec 'set -e'`, { kind: 'static', interpreter: 'bash', script: 'set -e' }],
    [`python -c 'print(1)'`, { kind: 'static', interpreter: 'python', script: 'print(1)' }],
    [
      `node --eval='console.log(1)'`,
      { kind: 'static', interpreter: 'node', script: 'console.log(1)' },
    ],
    [`ruby -e 'puts 1'`, { kind: 'static', interpreter: 'ruby', script: 'puts 1' }],
  ] as const)('decodes interpreter argv: %s', (command, expected) => {
    expect(decodeRecursiveInvocation(lexShell(command).tokens)).toMatchObject(expected)
  })

  it.each([
    `python script.py -c value`,
    `node app.js --eval value`,
    `ruby script.rb -e value`,
  ])('does not read a script flag after the file operand: %s', (command) => {
    expect(decodeRecursiveInvocation(lexShell(command).tokens)).toEqual({ kind: 'none' })
  })

  it.each([
    `sh -c`,
    `python -c`,
    `node --eval`,
  ])('fails closed when a script operand is missing: %s', (command) => {
    expect(decodeRecursiveInvocation(lexShell(command).tokens).kind).toBe('indeterminate')
  })

  it('distinguishes an empty static script from no recursive invocation', () => {
    expect(decodeRecursiveInvocation(lexShell(`sh -c ''`).tokens)).toMatchObject({
      kind: 'static',
      script: '',
    })
  })

  it.each([
    `sh -c "$CMD"`,
    `node --eval "$CODE"`,
  ])('marks an outer-expanded script dynamic: %s', (command) => {
    expect(decodeRecursiveInvocation(lexShell(command).tokens).kind).toBe('dynamic')
  })

  it('fails closed on an unknown option before the script boundary', () => {
    expect(
      decodeRecursiveInvocation(lexShell(`python --future value -c 'print(1)'`).tokens),
    ).toEqual({
      kind: 'indeterminate',
      interpreter: 'python',
      signal: 'shell.interpreter_option_unknown',
    })
  })
})
