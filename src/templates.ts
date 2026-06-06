import type { BelayConfig } from './types.js'

function inlineJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function renderConfig(config: BelayConfig): string {
  return `${inlineJson(config)}\n`
}

export function renderBeforeSubmitHook(): string {
  return `import { runBeforeSubmitPromptHook } from '../belay/runtime/core.mjs'

await runBeforeSubmitPromptHook()
`
}

export function renderShellGateHook(): string {
  return `import { runShellGateHook } from '../belay/runtime/core.mjs'

await runShellGateHook()
`
}

export function renderToolGateHook(): string {
  return `import { runToolGateHook } from '../belay/runtime/core.mjs'

const eventName = process.argv[2] ?? 'preToolUse'
await runToolGateHook(eventName)
`
}

export function renderAuditHook(): string {
  return `import { runAuditHook } from '../belay/runtime/core.mjs'

const eventName = process.argv[2] ?? 'postToolUse'
await runAuditHook(eventName)
`
}

export function renderRuntimeCore(config: BelayConfig): string {
  const configLiteral = inlineJson(config)
  return `import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// Heuristic Cursor hook classifier for Belay-style gating.
// This is intentionally not the abstract Belay substrate model itself.
const DEFAULT_CONFIG = ${configLiteral}

const EMPTY_APPROVALS = {
  version: 1,
  approvals: [],
}

const UUID_PATTERN = /\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b/gi
const TIMESTAMP_PATTERN = /\\b\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z\\b/g
const APPROVAL_ID_PATTERN = /\\bbelay_[a-z0-9]{8,}\\b/gi
const TOKEN_PREFIX_PATTERN = /\\/belay-approve\\s+\\S+/gi
const ENV_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\\S+)$/
const READ_ONLY_COMMANDS = new Set([
  'cat',
  'cd',
  'echo',
  'find',
  'git diff',
  'git log',
  'git rev-parse',
  'git show',
  'git status',
  'head',
  'ls',
  'node',
  'pwd',
  'rg',
  'sed',
  'sort',
  'tail',
  'wc',
  'which',
])
const FLAGGED_COMMANDS = new Set([
  'cp',
  'git add',
  'git commit',
  'git mv',
  'mkdir',
  'mv',
  'rm',
  'tee',
  'touch',
])
const EXTERNAL_COMMANDS = new Set([
  'aws',
  'curl',
  'gh',
  'git push',
  'gcloud',
  'kubectl',
  'netlify',
  'npm publish',
  'pnpm publish',
  'rsync',
  'scp',
  'ssh',
  'vercel',
  'wget',
])
const EXTERNAL_SUBAGENT_TERMS = [
  'deploy',
  'production',
  'publish',
  'release',
  'ship',
  'push',
  'notify',
  'send',
  'email',
  'external api',
  'prod',
]

function jsonResponse(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}

async function readStdinJson() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  }
  const raw = chunks.join('').trim()
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function findRepoRoot(startPath) {
  let current = path.resolve(startPath)
  while (true) {
    if (existsSync(path.join(current, '.git')) || existsSync(path.join(current, '.cursor'))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return path.resolve(startPath)
    }
    current = parent
  }
}

async function loadJsonFile(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function writeJsonFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\\n', 'utf8')
}

async function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
  const loaded = await loadJsonFile(configPath, DEFAULT_CONFIG)
  return {
    configPath,
    config: {
      ...DEFAULT_CONFIG,
      ...loaded,
      gates: {
        ...DEFAULT_CONFIG.gates,
        ...(loaded.gates ?? {}),
      },
      audit: {
        ...DEFAULT_CONFIG.audit,
        ...(loaded.audit ?? {}),
      },
    },
  }
}

function approvalsPath(repoRoot, fileName) {
  return path.join(repoRoot, '.cursor', 'belay', fileName)
}

async function loadApprovals(repoRoot, fileName) {
  const filePath = approvalsPath(repoRoot, fileName)
  const loaded = await loadJsonFile(filePath, EMPTY_APPROVALS)
  return {
    filePath,
    state: {
      version: 1,
      approvals: Array.isArray(loaded.approvals) ? loaded.approvals : [],
    },
  }
}

function nowIso() {
  return new Date().toISOString()
}

function isExpired(approval) {
  return Date.parse(approval.expiresAt) <= Date.now()
}

function compactApprovals(state) {
  return {
    version: 1,
    approvals: state.approvals.filter((approval) => !isExpired(approval)),
  }
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalStringify(item)).join(',') + ']'
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  return '{' + entries.map(([key, child]) => JSON.stringify(key) + ':' + canonicalStringify(child)).join(',') + '}'
}

function hashValue(value) {
  return createHash('sha256').update(value).digest('hex')
}

function relativeWithinRepo(repoRoot, targetPath) {
  const resolvedRoot = path.resolve(repoRoot)
  const resolvedTarget = path.resolve(targetPath)
  const relativePath = path.relative(resolvedRoot, resolvedTarget)
  if (relativePath === '') {
    return '.'
  }
  if (relativePath.startsWith('..')) {
    return null
  }
  return relativePath
}

function normalizeToken(token, repoRoot) {
  if (!path.isAbsolute(token)) {
    return token
  }
  const relativePath = relativeWithinRepo(repoRoot, token)
  return relativePath ?? token
}

function resolveMutationTarget(token, cwd) {
  if (!token || token === '--' || token.startsWith('-')) {
    return null
  }
  if (token === '2>' || token === '1>' || token === '&>' || token === '1>>' || token === '2>>') {
    return null
  }
  if (path.isAbsolute(token)) {
    return path.resolve(token)
  }
  if (token.startsWith('./') || token.startsWith('../')) {
    return path.resolve(cwd, token)
  }
  return null
}

function hasOutsideRepoPath(tokens, cwd, repoRoot) {
  return tokens.some((token) => {
    const resolved = resolveMutationTarget(token, cwd)
    if (!resolved) {
      return false
    }
    return relativeWithinRepo(repoRoot, resolved) === null
  })
}

function tokenizeShell(input) {
  const tokens = []
  let buffer = ''
  let quote = null
  let escaping = false
  const flush = () => {
    if (buffer.length > 0) {
      tokens.push(buffer)
      buffer = ''
    }
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1] ?? ''
    if (escaping) {
      buffer += char
      escaping = false
      continue
    }
    if (char === '\\\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        buffer += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '&' && next === '&') {
      flush()
      tokens.push('&&')
      index += 1
      continue
    }
    if (char === '|' && next === '|') {
      flush()
      tokens.push('||')
      index += 1
      continue
    }
    if (char === '>' && next === '>') {
      flush()
      tokens.push('>>')
      index += 1
      continue
    }
    if (char === '|' || char === ';' || char === '>' || char === '<') {
      flush()
      tokens.push(char)
      continue
    }
    if (/\\s/.test(char)) {
      flush()
      continue
    }
    buffer += char
  }
  flush()
  return tokens
}

function normalizeShellCommand(command, repoRoot) {
  const tokens = tokenizeShell(command)
  while (tokens.length > 0 && ENV_PREFIX_PATTERN.test(tokens[0] ?? '')) {
    tokens.shift()
  }
  const normalized = tokens.map((token) => normalizeToken(token, repoRoot))
  return normalized.join(' ').trim()
}

function splitTopLevelSegments(tokens) {
  const segments = []
  let current = []
  for (const token of tokens) {
    if (token === '&&' || token === '||' || token === ';' || token === '|') {
      if (current.length > 0) {
        segments.push(current)
      }
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) {
    segments.push(current)
  }
  return segments
}

function commandKey(tokens) {
  const filtered = tokens.filter((token) => token !== 'sudo')
  const first = filtered[0] ?? ''
  const second = filtered[1] ?? ''
  if ((first === 'git' || first === 'npm' || first === 'pnpm' || first === 'docker') && second) {
    return first + ' ' + second
  }
  return first
}

function extractRedirectTargets(tokens) {
  const targets = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '>' || token === '>>' || token === '<') {
      const next = tokens[index + 1]
      if (next) {
        targets.push(next)
      }
    }
  }
  return targets
}

function classifyShell(command, cwd, repoRoot) {
  const tokens = tokenizeShell(command)
  const segments = splitTopLevelSegments(tokens)
  const normalizedCommand = normalizeShellCommand(command, repoRoot)
  const cwdRelative = relativeWithinRepo(repoRoot, cwd) ?? cwd
  let effectiveVerdict = 'allow'
  let reason = 'read_only'
  let assessment = {
    reversibility: 'reversible',
    external: false,
    blastRadius: 'this repository',
    confidence: 0.95,
  }

  for (const segment of segments) {
    const key = commandKey(segment)
    const redirects = extractRedirectTargets(segment)
    const hasOutsideRedirect = redirects.some((target) => {
      const resolved = resolveMutationTarget(target, cwd)
      if (!resolved) {
        return false
      }
      return relativeWithinRepo(repoRoot, resolved) === null
    })
    if (hasOutsideRedirect) {
      return {
        verdict: 'deny_pending_approval',
        reason: 'outside_repo_redirect',
        normalizedCommand,
        fingerprint: hashValue('shell:' + cwdRelative + ':' + normalizedCommand),
        assessment: {
          reversibility: 'irreversible',
          external: true,
          blastRadius: 'outside the repository',
          confidence: 0.92,
        },
      }
    }
    if (FLAGGED_COMMANDS.has(key) && hasOutsideRepoPath(segment.slice(1), cwd, repoRoot)) {
      return {
        verdict: 'deny_pending_approval',
        reason: 'outside_repo_mutation',
        normalizedCommand,
        fingerprint: hashValue('shell:' + cwdRelative + ':' + normalizedCommand),
        assessment: {
          reversibility: 'irreversible',
          external: true,
          blastRadius: 'outside the repository',
          confidence: 0.9,
        },
      }
    }
    if (EXTERNAL_COMMANDS.has(key)) {
      return {
        verdict: 'deny_pending_approval',
        reason: 'external_effect',
        normalizedCommand,
        fingerprint: hashValue('shell:' + cwdRelative + ':' + normalizedCommand),
        assessment: {
          reversibility: 'irreversible',
          external: true,
          blastRadius: key === 'git push' ? 'remote origin' : 'external system',
          confidence: 0.92,
        },
      }
    }
    if (READ_ONLY_COMMANDS.has(key)) {
      continue
    }
    if (FLAGGED_COMMANDS.has(key) || redirects.length > 0) {
      effectiveVerdict = 'allow_flagged'
      reason = 'local_mutation'
      assessment = {
        reversibility: 'recoverable_with_cost',
        external: false,
        blastRadius: 'this repository',
        confidence: 0.72,
      }
      continue
    }

    effectiveVerdict = 'allow_flagged'
    reason = 'unknown_local_effect'
    assessment = {
      reversibility: 'recoverable_with_cost',
      external: false,
      blastRadius: 'this repository',
      confidence: 0.61,
    }
  }

  return {
    verdict: effectiveVerdict,
    reason,
    normalizedCommand,
    fingerprint: hashValue('shell:' + cwdRelative + ':' + normalizedCommand),
    assessment,
  }
}

function scrubString(value) {
  return value
    .replace(UUID_PATTERN, '<uuid>')
    .replace(TIMESTAMP_PATTERN, '<timestamp>')
    .replace(APPROVAL_ID_PATTERN, '<approval-id>')
    .replace(TOKEN_PREFIX_PATTERN, '/belay-approve <approval-id>')
}

function scrubValue(value) {
  if (typeof value === 'string') {
    return scrubString(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item))
  }
  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, child] of Object.entries(value)) {
      result[key] = scrubValue(child)
    }
    return result
  }
  return value
}

function escapeRegex(value) {
  const specials = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\\\'])
  return [...value].map((char) => (specials.has(char) ? '\\\\' + char : char)).join('')
}

function classifySubagent(payload, repoRoot) {
  const kind = payload.tool_name === 'Task' ? 'Task' : String(payload.subagent_type ?? 'generalPurpose')
  const sourceValue = payload.tool_name === 'Task' ? payload.tool_input ?? {} : payload.task ?? payload
  const scrubbed = scrubValue(sourceValue)
  const summary = typeof scrubbed === 'string' ? scrubbed : canonicalStringify(scrubbed)
  const lowered = summary.toLowerCase()
  const fingerprint = hashValue(
    'subagent:' +
      kind +
      ':' +
      canonicalStringify(scrubbed) +
      ':' +
      path.resolve(repoRoot),
  )

  const hasExternalTerm = EXTERNAL_SUBAGENT_TERMS.some((term) => lowered.includes(term))
  if (hasExternalTerm) {
    return {
      verdict: 'deny_pending_approval',
      reason: 'external_subagent_intent',
      summary,
      fingerprint,
      assessment: {
        reversibility: 'irreversible',
        external: true,
        blastRadius: 'subagent requested external effect',
        confidence: 0.9,
      },
    }
  }

  return {
    verdict: 'allow_flagged',
    reason: 'subagent_review',
    summary,
    fingerprint,
    assessment: {
      reversibility: 'recoverable_with_cost',
      external: false,
      blastRadius: 'subagent task scope',
      confidence: 0.67,
    },
  }
}

async function appendAudit(repoRoot, event) {
  const { config } = await loadConfig(repoRoot)
  const auditPath = path.join(repoRoot, config.audit.logPath)
  await mkdir(path.dirname(auditPath), { recursive: true })
  await writeFile(auditPath, JSON.stringify({ timestamp: nowIso(), ...event }) + '\\n', {
    encoding: 'utf8',
    flag: 'a',
  })
}

function buildRetryInstruction(tokenPrefix, approvalId) {
  return 'To allow the next matching action once, send ' + tokenPrefix + ' ' + approvalId + ' and then retry the original action unchanged.'
}

async function ensurePendingApproval(repoRoot, kind, fingerprint, reason, summary, config) {
  const pending = await loadApprovals(repoRoot, 'pending-approvals.json')
  pending.state = compactApprovals(pending.state)
  const existing = pending.state.approvals.find(
    (approval) =>
      approval.kind === kind &&
      approval.fingerprint === fingerprint &&
      approval.repoRoot === repoRoot,
  )
  if (existing) {
    await writeJsonFile(pending.filePath, pending.state)
    return existing
  }

  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + config.approvalTtlMinutes * 60_000).toISOString()
  const approval = {
    approvalId: 'belay_' + randomUUID().replaceAll('-', '').slice(0, 12),
    kind,
    fingerprint,
    repoRoot,
    reason,
    summary,
    createdAt,
    expiresAt,
  }
  pending.state.approvals.push(approval)
  await writeJsonFile(pending.filePath, pending.state)
  return approval
}

async function consumeApprovedApproval(repoRoot, kind, fingerprint) {
  const approved = await loadApprovals(repoRoot, 'approved-approvals.json')
  approved.state = compactApprovals(approved.state)
  const index = approved.state.approvals.findIndex(
    (approval) =>
      approval.kind === kind &&
      approval.fingerprint === fingerprint &&
      approval.repoRoot === repoRoot,
  )
  if (index === -1) {
    await writeJsonFile(approved.filePath, approved.state)
    return null
  }
  const [approval] = approved.state.approvals.splice(index, 1)
  await writeJsonFile(approved.filePath, approved.state)
  return approval
}

async function movePendingToApproved(repoRoot, approvalId) {
  const pending = await loadApprovals(repoRoot, 'pending-approvals.json')
  pending.state = compactApprovals(pending.state)
  const index = pending.state.approvals.findIndex((approval) => approval.approvalId === approvalId)
  if (index === -1) {
    await writeJsonFile(pending.filePath, pending.state)
    return { ok: false, message: 'Belay approval not found or expired.' }
  }
  const [approval] = pending.state.approvals.splice(index, 1)
  await writeJsonFile(pending.filePath, pending.state)

  const approved = await loadApprovals(repoRoot, 'approved-approvals.json')
  approved.state = compactApprovals(approved.state)
  approved.state.approvals.push({
    ...approval,
    approvedAt: nowIso(),
  })
  await writeJsonFile(approved.filePath, approved.state)
  return { ok: true, message: 'Belay approval recorded for ' + approvalId + '. Retry the original action once before it expires.' }
}

function approvalCommandMatch(prompt, tokenPrefix) {
  const escapedPrefix = escapeRegex(tokenPrefix)
  const match = prompt.match(new RegExp('^\\\\s*' + escapedPrefix + '\\\\s+(\\\\S+)\\\\s*$', 'i'))
  return match?.[1] ?? null
}

async function gateDecisionToResponse({ repoRoot, kind, result, config }) {
  const approved = await consumeApprovedApproval(repoRoot, kind, result.fingerprint)
  if (approved) {
    await appendAudit(repoRoot, {
      event: kind === 'shell' ? 'beforeShellExecution' : 'subagentApproval',
      kind,
      verdict: 'allow',
      reason: 'approved_once',
      approvalId: approved.approvalId,
      fingerprint: result.fingerprint,
      summary: result.normalizedCommand ?? result.summary ?? '',
      assessment: result.assessment,
    })
    return {
      permission: 'allow',
    }
  }

  if (result.verdict === 'allow') {
    await appendAudit(repoRoot, {
      event: kind === 'shell' ? 'beforeShellExecution' : 'subagentGate',
      kind,
      verdict: result.verdict,
      reason: result.reason,
      fingerprint: result.fingerprint,
      summary: result.normalizedCommand ?? result.summary ?? '',
      assessment: result.assessment,
    })
    return {
      permission: 'allow',
    }
  }

  if (result.verdict === 'allow_flagged') {
    await appendAudit(repoRoot, {
      event: kind === 'shell' ? 'beforeShellExecution' : 'subagentGate',
      kind,
      verdict: result.verdict,
      reason: result.reason,
      fingerprint: result.fingerprint,
      summary: result.normalizedCommand ?? result.summary ?? '',
      assessment: result.assessment,
    })
    return {
      permission: 'allow',
    }
  }

  const approval = await ensurePendingApproval(
    repoRoot,
    kind,
    result.fingerprint,
    result.reason,
    result.normalizedCommand ?? result.summary ?? '',
    config,
  )
  await appendAudit(repoRoot, {
    event: kind === 'shell' ? 'beforeShellExecution' : 'subagentGate',
    kind,
    verdict: result.verdict,
    reason: result.reason,
    approvalId: approval.approvalId,
    fingerprint: result.fingerprint,
    summary: result.normalizedCommand ?? result.summary ?? '',
    assessment: result.assessment,
  })

  if (config.mode === 'audit') {
    return {
      permission: 'allow',
    }
  }

  return {
    permission: 'deny',
    user_message:
      'Belay blocked this high-risk action. Approval ID: ' +
      approval.approvalId +
      '. ' +
      buildRetryInstruction(config.tokenPrefix, approval.approvalId),
    agent_message:
      'Belay denied this action as ' +
      result.reason +
      '. Wait for approval, then retry the exact same action once.',
  }
}

export async function runBeforeSubmitPromptHook() {
  try {
    const payload = await readStdinJson()
    const prompt = String(payload.prompt ?? '')
    const repoRoot = findRepoRoot(process.cwd())
    const { config } = await loadConfig(repoRoot)
    const approvalId = approvalCommandMatch(prompt, config.tokenPrefix)
    if (!approvalId) {
      jsonResponse({ continue: true })
      return
    }

    const moved = await movePendingToApproved(repoRoot, approvalId)
    await appendAudit(repoRoot, {
      event: 'beforeSubmitPrompt',
      kind: 'approval',
      verdict: moved.ok ? 'allow' : 'deny_pending_approval',
      approvalId,
      reason: moved.ok ? 'approval_recorded' : 'approval_missing',
      summary: prompt,
    })
    jsonResponse({
      continue: false,
      user_message: moved.message,
    })
  } catch (error) {
    jsonResponse({
      continue: false,
      user_message:
        'agent-belay failed while processing approval state. Run agent-belay doctor, then retry.',
    })
  }
}

export async function runShellGateHook() {
  try {
    const payload = await readStdinJson()
    const command = String(payload.command ?? '').trim()
    const cwd = String(payload.cwd ?? process.cwd()).trim() || process.cwd()
    const repoRoot = findRepoRoot(cwd)
    const { config } = await loadConfig(repoRoot)
    if (!config.gates.shell) {
      jsonResponse({ permission: 'allow' })
      return
    }
    const result = classifyShell(command, cwd, repoRoot)
    const response = await gateDecisionToResponse({
      repoRoot,
      kind: 'shell',
      result,
      config,
    })
    jsonResponse(response)
  } catch (error) {
    jsonResponse({
      permission: 'deny',
      user_message:
        'agent-belay failed while classifying this shell command. Run agent-belay doctor, then retry.',
    })
  }
}

export async function runToolGateHook(eventName) {
  try {
    const payload = await readStdinJson()
    const cwd = process.cwd()
    const repoRoot = findRepoRoot(cwd)
    const { config } = await loadConfig(repoRoot)
    if (!config.gates.subagent) {
      jsonResponse({ permission: 'allow' })
      return
    }
    const result = classifySubagent(payload, repoRoot)
    const response = await gateDecisionToResponse({
      repoRoot,
      kind: 'subagent',
      result,
      config,
    })
    jsonResponse(response)
  } catch (error) {
    jsonResponse({
      permission: 'deny',
      user_message:
        'agent-belay failed while classifying this subagent action. Run agent-belay doctor, then retry.',
    })
  }
}

export async function runAuditHook(eventName) {
  try {
    const payload = await readStdinJson()
    const repoRoot = findRepoRoot(process.cwd())
    await appendAudit(repoRoot, {
      event: eventName,
      kind: 'audit',
      verdict: 'allow',
      reason: 'observed',
      summary: canonicalStringify(scrubValue(payload)),
    })
    jsonResponse({})
  } catch (error) {
    console.error('agent-belay audit hook failed:', error instanceof Error ? error.message : String(error))
    jsonResponse({})
  }
}
`
}
