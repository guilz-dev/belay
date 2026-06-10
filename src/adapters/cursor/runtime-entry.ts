import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  type ApprovalStateFile,
  approvalCommandMatch,
  type BelayConfigV2,
  buildRetryInstruction,
  type ClassifyResult,
  canonicalStringify,
  classifierOptionsFromConfig,
  classifyShell,
  classifySubagent,
  classifyToolUse,
  compactApprovals,
  createApprovalRecord,
  mergeConfig,
  scrubValue,
} from '../../core/index.js'
import { PACKAGE_VERSION } from '../../version.js'

export const RUNTIME_PACKAGE_VERSION = PACKAGE_VERSION

const EMPTY_APPROVALS: ApprovalStateFile = {
  version: 1,
  approvals: [],
}

function jsonResponse(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: string[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  }
  const raw = chunks.join('').trim()
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function findRepoRoot(startPath: string): string {
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

async function loadJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function loadConfig(
  repoRoot: string,
): Promise<{ configPath: string; config: BelayConfigV2 }> {
  const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
  const loaded = await loadJsonFile(configPath, {})
  return {
    configPath,
    config: mergeConfig(loaded),
  }
}

function approvalsPath(repoRoot: string, fileName: string): string {
  return path.join(repoRoot, '.cursor', 'belay', fileName)
}

async function loadApprovals(repoRoot: string, fileName: string) {
  const filePath = approvalsPath(repoRoot, fileName)
  const loaded = await loadJsonFile<ApprovalStateFile>(filePath, EMPTY_APPROVALS)
  return {
    filePath,
    state: {
      version: 1 as const,
      approvals: Array.isArray(loaded.approvals) ? loaded.approvals : [],
    },
  }
}

async function appendAudit(
  repoRoot: string,
  config: BelayConfigV2,
  event: Record<string, unknown>,
) {
  const auditPath = path.join(repoRoot, config.audit.logPath)
  await mkdir(path.dirname(auditPath), { recursive: true })
  const record: Record<string, unknown> = { timestamp: new Date().toISOString(), ...event }
  if (!config.audit.includeAssessment) {
    delete record.assessment
  }
  await writeFile(auditPath, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    flag: 'a',
  })
}

async function ensurePendingApproval(
  repoRoot: string,
  kind: 'shell' | 'subagent' | 'tool',
  result: ClassifyResult,
  config: BelayConfigV2,
) {
  const pending = await loadApprovals(repoRoot, 'pending-approvals.json')
  pending.state = compactApprovals(pending.state)
  const existing = pending.state.approvals.find(
    (approval) =>
      approval.kind === kind &&
      approval.fingerprint === result.fingerprint &&
      approval.repoRoot === repoRoot,
  )
  if (existing) {
    await writeJsonFile(pending.filePath, pending.state)
    return existing
  }

  const approval = createApprovalRecord({
    kind,
    fingerprint: result.fingerprint,
    repoRoot,
    reason: result.reason,
    summary: result.normalizedCommand ?? result.summary ?? '',
    approvalTtlMinutes: config.approvalTtlMinutes,
    approvalId: `belay_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
  })
  pending.state.approvals.push(approval)
  await writeJsonFile(pending.filePath, pending.state)
  return approval
}

async function consumeApprovedApproval(
  repoRoot: string,
  kind: 'shell' | 'subagent' | 'tool',
  fingerprint: string,
) {
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

async function movePendingToApproved(repoRoot: string, approvalId: string) {
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
    approvedAt: new Date().toISOString(),
  })
  await writeJsonFile(approved.filePath, approved.state)
  return {
    ok: true,
    message: `Belay approval recorded for ${approvalId}. Retry the original action once before it expires.`,
  }
}

async function gateDecisionToResponse(params: {
  repoRoot: string
  kind: 'shell' | 'subagent' | 'tool'
  result: ClassifyResult
  config: BelayConfigV2
}) {
  const { repoRoot, kind, result, config } = params
  const approved = await consumeApprovedApproval(repoRoot, kind, result.fingerprint)
  if (approved) {
    await appendAudit(repoRoot, config, {
      event:
        kind === 'shell' ? 'beforeShellExecution' : kind === 'tool' ? 'preToolUse' : 'subagentGate',
      kind,
      verdict: 'allow',
      reason: 'approved_once',
      approvalId: approved.approvalId,
      fingerprint: result.fingerprint,
      summary: result.normalizedCommand ?? result.summary ?? '',
      assessment: result.assessment,
    })
    return { permission: 'allow' }
  }

  if (result.verdict === 'allow' || result.verdict === 'allow_flagged') {
    await appendAudit(repoRoot, config, {
      event:
        kind === 'shell' ? 'beforeShellExecution' : kind === 'tool' ? 'preToolUse' : 'subagentGate',
      kind,
      verdict: result.verdict,
      reason: result.reason,
      fingerprint: result.fingerprint,
      summary: result.normalizedCommand ?? result.summary ?? '',
      assessment: result.assessment,
    })
    return { permission: 'allow' }
  }

  const approval = await ensurePendingApproval(repoRoot, kind, result, config)
  await appendAudit(repoRoot, config, {
    event:
      kind === 'shell' ? 'beforeShellExecution' : kind === 'tool' ? 'preToolUse' : 'subagentGate',
    kind,
    verdict: result.verdict,
    reason: result.reason,
    approvalId: approval.approvalId,
    fingerprint: result.fingerprint,
    summary: result.normalizedCommand ?? result.summary ?? '',
    assessment: result.assessment,
  })

  if (config.mode === 'audit') {
    return { permission: 'allow' }
  }

  return {
    permission: 'deny',
    user_message: `Belay blocked this high-risk action. Approval ID: ${approval.approvalId}. ${buildRetryInstruction(config.tokenPrefix, approval.approvalId)}`,
    agent_message: `Belay denied this action as ${result.reason}. Wait for approval, then retry the exact same action once.`,
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
    await appendAudit(repoRoot, config, {
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
  } catch {
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
    const options = classifierOptionsFromConfig(config)
    const result = classifyShell(command, cwd, repoRoot, options)
    const response = await gateDecisionToResponse({
      repoRoot,
      kind: 'shell',
      result,
      config,
    })
    jsonResponse(response)
  } catch {
    jsonResponse({
      permission: 'deny',
      user_message:
        'agent-belay failed while classifying this shell command. Run agent-belay doctor, then retry.',
    })
  }
}

function isSubagentEvent(payload: Record<string, unknown>, eventName: string): boolean {
  return eventName === 'subagentStart' || payload.subagent_type !== undefined
}

function isFileMutationTool(toolName: string): boolean {
  return toolName === 'Write' || toolName === 'StrReplace' || toolName === 'Delete'
}

export async function runToolGateHook(eventName: string) {
  try {
    const payload = await readStdinJson()
    const cwd = process.cwd()
    const repoRoot = findRepoRoot(cwd)
    const { config } = await loadConfig(repoRoot)
    const options = classifierOptionsFromConfig(config)
    const toolName = String(payload.tool_name ?? '')

    if (isSubagentEvent(payload, eventName)) {
      if (!config.gates.subagent) {
        jsonResponse({ permission: 'allow' })
        return
      }
      const result = classifySubagent(payload, repoRoot, options)
      const response = await gateDecisionToResponse({
        repoRoot,
        kind: 'subagent',
        result,
        config,
      })
      jsonResponse(response)
      return
    }

    if (toolName === 'Shell') {
      if (!config.gates.toolShell) {
        jsonResponse({ permission: 'allow' })
        return
      }
      const result = classifyToolUse(payload, repoRoot, cwd, options)
      const response = await gateDecisionToResponse({
        repoRoot,
        kind: 'tool',
        result,
        config,
      })
      jsonResponse(response)
      return
    }

    if (isFileMutationTool(toolName)) {
      if (!config.gates.fileMutation) {
        jsonResponse({ permission: 'allow' })
        return
      }
      const result = classifyToolUse(payload, repoRoot, cwd, options)
      const response = await gateDecisionToResponse({
        repoRoot,
        kind: 'tool',
        result,
        config,
      })
      jsonResponse(response)
      return
    }

    if (payload.tool_name === 'Task') {
      if (!config.gates.subagent) {
        jsonResponse({ permission: 'allow' })
        return
      }
      const result = classifySubagent(payload, repoRoot, options)
      const response = await gateDecisionToResponse({
        repoRoot,
        kind: 'subagent',
        result,
        config,
      })
      jsonResponse(response)
      return
    }

    jsonResponse({ permission: 'allow' })
  } catch {
    jsonResponse({
      permission: 'deny',
      user_message:
        'agent-belay failed while classifying this tool action. Run agent-belay doctor, then retry.',
    })
  }
}

export async function runAuditHook(eventName: string) {
  try {
    const payload = await readStdinJson()
    const repoRoot = findRepoRoot(process.cwd())
    const { config } = await loadConfig(repoRoot)
    await appendAudit(repoRoot, config, {
      event: eventName,
      kind: 'audit',
      verdict: 'allow',
      reason: 'observed',
      summary: canonicalStringify(scrubValue(payload)),
    })
    jsonResponse({})
  } catch (error) {
    console.error(
      'agent-belay audit hook failed:',
      error instanceof Error ? error.message : String(error),
    )
    jsonResponse({})
  }
}
