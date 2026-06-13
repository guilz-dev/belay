import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { codexAdapter } from '../../adapters/codex/adapter.js'
import {
  CODEX_HOOKS_BEGIN,
  CODEX_HOOKS_END,
  mergeCodexHooksToml,
  renderCodexHooksToml,
} from '../../adapters/codex/hooks.js'
import { codexLayout } from '../../adapters/layouts/codex.js'
import {
  gateVerdictToCodexPreToolUseResponse,
  gateVerdictToCodexUserPromptResponse,
} from '../../adapters/shared/gate-runtime.js'
import { unnormalizedGateVerdict } from '../../core/gate-contract.js'

describe('codex adapter (experimental)', () => {
  describe('TOML hook rendering', () => {
    it('renders a marker-delimited PreToolUse/UserPromptSubmit/PostToolUse block', () => {
      const toml = renderCodexHooksToml('darwin')
      expect(toml).toContain(CODEX_HOOKS_BEGIN)
      expect(toml).toContain(CODEX_HOOKS_END)
      expect(toml).toContain('[[hooks.PreToolUse]]')
      expect(toml).toContain('[[hooks.UserPromptSubmit]]')
      expect(toml).toContain('[[hooks.PostToolUse]]')
      expect(toml).toContain('belay-runner')
      expect(toml).toContain('belay-tool-gate')
    })

    it('merges idempotently: re-merge keeps exactly one managed block and preserves user content', () => {
      const userToml = 'model = "gpt-5"\n\n[features]\njs_repl = false\n'
      const once = mergeCodexHooksToml(userToml, 'darwin')
      const twice = mergeCodexHooksToml(once, 'darwin')
      // user content preserved
      expect(twice).toContain('model = "gpt-5"')
      expect(twice).toContain('js_repl = false')
      // exactly one managed block
      const begins = twice.split(CODEX_HOOKS_BEGIN).length - 1
      const ends = twice.split(CODEX_HOOKS_END).length - 1
      expect(begins).toBe(1)
      expect(ends).toBe(1)
      // idempotent
      expect(twice).toBe(once)
    })
  })

  describe('Codex deny contract', () => {
    it('PreToolUse: non-allow verdict -> permissionDecision deny (Claude-identical shape)', () => {
      const verdict = unnormalizedGateVerdict({
        reason: 'tier0_external',
        mode: 'enforce',
        user_message: 'Belay blocked a registry publish.',
      })
      const response = gateVerdictToCodexPreToolUseResponse(verdict) as {
        hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string }
      }
      expect(response.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
      expect(response.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(response.hookSpecificOutput?.permissionDecisionReason).toBe(
        'Belay blocked a registry publish.',
      )
    })

    it('PreToolUse: allow verdict -> empty response', () => {
      const allow = {
        ...unnormalizedGateVerdict({ reason: 'ok', mode: 'enforce', user_message: 'ok' }),
        permission: 'allow' as const,
      }
      expect(gateVerdictToCodexPreToolUseResponse(allow)).toEqual({})
    })

    it('UserPromptSubmit: block uses { decision: "block" } (Codex contract)', () => {
      expect(
        gateVerdictToCodexUserPromptResponse({ continue: false, user_message: 'pending approval' }),
      ).toEqual({ decision: 'block', reason: 'pending approval' })
      expect(gateVerdictToCodexUserPromptResponse({ continue: true })).toEqual({})
    })
  })

  describe('install', () => {
    it('writes .codex/config.toml hooks + belay config + runtime', async () => {
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-codex-'))
      await mkdir(path.join(repoRoot, '.git'))
      await codexAdapter.install(repoRoot, {})

      const configToml = await readFile(codexLayout.hooksSettingsPath(repoRoot), 'utf8')
      expect(configToml).toContain(CODEX_HOOKS_BEGIN)
      expect(configToml).toContain('[[hooks.PreToolUse]]')

      expect(existsSync(codexLayout.configPath(repoRoot))).toBe(true)
      expect(existsSync(path.join(codexLayout.runtimeDir(repoRoot), 'core.mjs'))).toBe(true)
      expect(existsSync(path.join(codexLayout.hooksDir(repoRoot), 'belay-runner'))).toBe(true)
    })

    it('doctor flags Codex as EXPERIMENTAL with unverified firing', async () => {
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-codex-doctor-'))
      await mkdir(path.join(repoRoot, '.git'))
      await codexAdapter.install(repoRoot, {})
      const report = await codexAdapter.doctor({ targetDir: repoRoot })
      expect(report.warnings.some((w) => w.includes('EXPERIMENTAL'))).toBe(true)
    })
  })
})
