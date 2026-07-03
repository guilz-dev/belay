/**
 * Command mutators for adversarial probe generation and structural-suite tests.
 *
 * AUTO_LABEL_MUTATORS: semantics-preserving transforms safe for must-ask auto-labeling.
 * STRUCTURAL_PROBES: fail-closed / parser regression probes — not for corpus auto-add.
 */

export interface CommandMutator {
  id: string
  purpose: string
  preservesSemantics: string
  forbiddenWhen: string
  tests: string[]
  apply: (core: string) => string
}

export interface MutatedCase {
  core: string
  mutatorId: string
  command: string
}

/** Must-ask catastrophic cores used as mutation seeds. */
export const CATASTROPHIC_CORES = [
  'rm -rf .git',
  'git push --force',
  'dropdb prod',
  'npm publish',
  'aws s3 rm s3://bucket/key',
  'terraform apply',
  'rm -rf ~',
] as const

const bashC: CommandMutator = {
  id: 'bash_c',
  purpose: 'Shell indirection via bash -c',
  preservesSemantics: 'bash -c executes the same command string in a subshell',
  forbiddenWhen: 'Core contains unescaped single quotes that break quoting',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence'],
  apply: (core) => `bash -c '${core}'`,
}

const envPrefix: CommandMutator = {
  id: 'env_prefix',
  purpose: 'Environment variable prefix wrapper',
  preservesSemantics: 'env FOO=1 does not alter command semantics for unrelated vars',
  forbiddenWhen: 'Core relies on empty or conflicting FOO value',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence'],
  apply: (core) => `env FOO=1 ${core}`,
}

const subshell: CommandMutator = {
  id: 'subshell',
  purpose: 'Parenthesized subshell wrapper',
  preservesSemantics: 'Subshell executes the same command sequence',
  forbiddenWhen: 'Core depends on shell state outside subshell scope',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence'],
  apply: (core) => `(${core})`,
}

const absolutePath: CommandMutator = {
  id: 'absolute_path',
  purpose: 'Absolute path to first token',
  preservesSemantics: '/usr/bin/<head> resolves to the same binary when on PATH',
  forbiddenWhen: 'Head token is not a bare command name or binary differs from PATH',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence'],
  apply: (core) => {
    const [head, ...rest] = core.split(' ')
    return `/usr/bin/${head} ${rest.join(' ')}`
  },
}

/** Phase A initial set — conservative semantics-preserving mutators only. */
export const AUTO_LABEL_MUTATORS: readonly CommandMutator[] = [
  bashC,
  envPrefix,
  subshell,
  absolutePath,
]

const nohup: CommandMutator = {
  id: 'nohup',
  purpose: 'Background execution via nohup',
  preservesSemantics: 'nohup runs the same command detached from terminal',
  forbiddenWhen: 'Core depends on foreground tty or job control',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence'],
  apply: (core) => `nohup ${core}`,
}

const sudo: CommandMutator = {
  id: 'sudo',
  purpose: 'Privilege elevation wrapper',
  preservesSemantics: 'sudo executes the same command with elevated privileges',
  forbiddenWhen: 'Core semantics depend on unprivileged execution context',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence'],
  apply: (core) => `sudo ${core}`,
}

const evalMutator: CommandMutator = {
  id: 'eval',
  purpose: 'eval string execution',
  preservesSemantics: 'eval re-parses and runs the same command string',
  forbiddenWhen: 'Core contains shell metacharacters that eval would reinterpret',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence'],
  apply: (core) => `eval "${core}"`,
}

const commandSubstitution: CommandMutator = {
  id: 'command_substitution',
  purpose: 'Command substitution wrapper $(core)',
  preservesSemantics: 'Not semantics-preserving — substitution output becomes argument context',
  forbiddenWhen: 'Always probe-only; do not auto-label',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence', 'v1 regression guards'],
  apply: (core) => `$(${core})`,
}

const echoSubstitution: CommandMutator = {
  id: 'echo_substitution',
  purpose: 'Echo with command substitution',
  preservesSemantics: 'Not semantics-preserving — inner command runs in substitution context',
  forbiddenWhen: 'Always probe-only; do not auto-label',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence'],
  apply: (core) => `echo $(${core})`,
}

const base64PipeSh: CommandMutator = {
  id: 'base64_pipe_sh',
  purpose: 'Pipe-to-shell obfuscation probe',
  preservesSemantics: 'Not semantics-preserving — decodes and pipes to sh',
  forbiddenWhen: 'Always probe-only; do not auto-label',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence'],
  apply: (core) => `echo "${core}" | base64 -d | sh`,
}

const pythonPipe: CommandMutator = {
  id: 'python_pipe',
  purpose: 'Pipe-to-python execution probe',
  preservesSemantics: 'Not semantics-preserving — python interprets piped input',
  forbiddenWhen: 'Always probe-only; do not auto-label',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence'],
  apply: (core) => `echo "${core}" | python3`,
}

const xargsProbe: CommandMutator = {
  id: 'xargs',
  purpose: 'xargs invocation probe',
  preservesSemantics: 'Not semantics-preserving — xargs changes argument delivery',
  forbiddenWhen: 'Always probe-only; do not auto-label',
  tests: ['structural-suite MUST-ASK catastrophic bypass equivalence'],
  apply: (core) => `xargs ${core} <<< ''`,
}

/** Structural probes and promotion candidates — not used for auto-label in Phase A. */
export const STRUCTURAL_PROBES: readonly CommandMutator[] = [
  nohup,
  sudo,
  evalMutator,
  commandSubstitution,
  echoSubstitution,
  base64PipeSh,
  pythonPipe,
  xargsProbe,
]

/** All wrappers for structural-suite catastrophic bypass tests. */
export const ALL_STRUCTURAL_WRAPPERS: readonly CommandMutator[] = [
  ...AUTO_LABEL_MUTATORS,
  ...STRUCTURAL_PROBES,
]

export function generateMutatedCases(
  cores: readonly string[],
  mutators: readonly CommandMutator[],
): MutatedCase[] {
  const cases: MutatedCase[] = []
  for (const core of cores) {
    for (const mutator of mutators) {
      cases.push({
        core,
        mutatorId: mutator.id,
        command: mutator.apply(core),
      })
    }
  }
  return cases
}
