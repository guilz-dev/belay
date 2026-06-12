import { describe, expect, it } from 'vitest'
import { verdict } from '../../core/v2/verdict.js'
import { v2TestContext } from './helpers.js'

const CATASTROPHIC_CORES = [
  'rm -rf .git',
  'git push --force',
  'dropdb prod',
  'npm publish',
  'aws s3 rm s3://bucket/key',
  'terraform apply',
  'rm -rf ~',
]

const WRAPPER_TRANSFORMS: Array<(core: string) => string> = [
  (core) => `bash -c '${core}'`,
  (core) => `env FOO=1 ${core}`,
  (core) => `nohup ${core}`,
  (core) => `sudo ${core}`,
  (core) => `eval "${core}"`,
  (core) => `$(${core})`,
  (core) => `echo $(${core})`,
  (core) => `echo "${core}" | base64 -d | sh`,
  (core) => `echo "${core}" | python3`,
  (core) => `xargs ${core} <<< ''`,
  (core) => `(${core})`,
  (core) => {
    const [head, ...rest] = core.split(' ')
    return `/usr/bin/${head} ${rest.join(' ')}`
  },
]

const MUST_ALLOW = ['npm test', 'npm run build', "bash -lc 'git status'"]

describe('v2 structural suite', () => {
  const context = v2TestContext()

  describe('MUST-ASK catastrophic bypass equivalence', () => {
    const cases: Array<{ name: string; command: string }> = []
    for (const core of CATASTROPHIC_CORES) {
      cases.push({ name: `core:${core}`, command: core })
      for (const wrap of WRAPPER_TRANSFORMS) {
        cases.push({ name: `wrapped:${wrap(core)}`, command: wrap(core) })
      }
    }

    it.each(cases)('$name → ask', async ({ command }) => {
      const result = await verdict(command, context)
      expect(result.permission, `false allow for: ${command}`).toBe('ask')
    })
  })

  describe('MUST-ALLOW routines', () => {
    it.each(MUST_ALLOW)('%s → allow', async (command) => {
      const result = await verdict(command, context)
      expect(result.permission, `false deny for routine: ${command}`).toBe('allow')
    })
  })

  describe('v1 regression guards', () => {
    it('find -delete is ask', async () => {
      const result = await verdict("find . -name '*.ts' -delete", context)
      expect(result.permission).toBe('ask')
    })

    it('denies substitution under fail-closed policy even when inner is read-only', async () => {
      const result = await verdict('echo $(git status)', context)
      expect(result.permission).toBe('ask')
      expect(result.reason).toBe('command_substitution')
    })

    it('npm install is ask under fail-closed defaults', async () => {
      const result = await verdict('npm install', context)
      expect(result.permission).toBe('ask')
    })
  })

  describe('fixed edge cases', () => {
    it('rm -rf .git is ask', async () => {
      const result = await verdict('rm -rf .git', context)
      expect(result.permission).toBe('ask')
    })

    it('docker push is ask (Tier0)', async () => {
      const result = await verdict('docker push myimage:latest', context)
      expect(result.permission).toBe('ask')
    })

    it('npm run deploy resolves recipe and asks', async () => {
      const result = await verdict('npm run deploy', context)
      expect(result.permission).toBe('ask')
    })
  })
})
