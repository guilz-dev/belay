import { describe, expect, it } from 'vitest'

import { lexShell } from '../../core/shell-tokenizer.js'
import { decodeRecursiveInvocation } from '../../core/verdict/recursive-invocation.js'

describe('decodeRecursiveInvocation', () => {
  it.each([
    [`bash -ec 'set -e'`, { kind: 'static', interpreter: 'bash', script: 'set -e' }],
    [`bash +O extglob -c 'set -e'`, { kind: 'static', interpreter: 'bash', script: 'set -e' }],
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

  it('decodes eval argv and rejects outer-shell expansion', () => {
    expect(decodeRecursiveInvocation(lexShell('eval echo ok').tokens)).toEqual({
      kind: 'static',
      interpreter: 'eval',
      script: 'echo ok',
    })
    expect(decodeRecursiveInvocation(lexShell('eval "$COMMAND"').tokens)).toEqual({
      kind: 'dynamic',
      interpreter: 'eval',
      signal: 'shell.script_expanded',
    })
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

  it.each([
    'bash --future value',
    'python --future value',
    'node --future value',
    'ruby --future value',
  ])('fails closed on an unsupported pre-positional option without a later script flag: %s', (command) => {
    expect(decodeRecursiveInvocation(lexShell(command).tokens)).toMatchObject({
      kind: 'indeterminate',
      signal: 'shell.interpreter_option_unknown',
    })
  })

  it.each([
    'node --version',
    'python --version',
    'ruby --version',
    'bash -n script.sh',
  ])('leaves a non-script interpreter invocation to ordinary decoding: %s', (command) => {
    expect(decodeRecursiveInvocation(lexShell(command).tokens)).toEqual({ kind: 'none' })
  })
})
