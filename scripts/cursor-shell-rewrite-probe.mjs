#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const RESULT_SPEC_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/superpowers/specs/2026-08-28-cursor-shell-rewrite-probe-result.md',
)
const USER_CURSOR_HOOKS_PATH = path.join(os.homedir(), '.cursor', 'hooks.json')
const PROBE_PREFIX = 'CURSOR_REWRITE_PROBE'
const CASE_TIMEOUT_MS = 120_000
const PREFLIGHT_TIMEOUT_MS = 15_000

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function valueAtPath(value, keys) {
  let current = value
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function firstString(value, paths) {
  for (const keys of paths) {
    const candidate = valueAtPath(value, keys)
    if (typeof candidate === 'string') return candidate
  }
  return ''
}

function firstNumber(value, paths) {
  for (const keys of paths) {
    const candidate = valueAtPath(value, keys)
    if (typeof candidate === 'number') return candidate
  }
  return null
}

function shellToolCalls(value, found = []) {
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const item of value) shellToolCalls(item, found)
    return found
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key.toLowerCase().includes('shell') && nested && typeof nested === 'object') {
      const command = firstString(nested, [['args', 'command'], ['command'], ['input', 'command']])
      if (command) {
        const result = nested.result ?? nested.output ?? nested
        const success = result?.success ?? result
        found.push({
          command,
          stdout: firstString(success, [['stdout'], ['output', 'stdout']]),
          stderr: firstString(success, [['stderr'], ['output', 'stderr']]),
          exitCode: firstNumber(success, [['exitCode'], ['exit_code'], ['statusCode']]),
        })
      }
    }
    shellToolCalls(nested, found)
  }
  return found
}

/**
 * Parse Cursor's documented NDJSON stream without assuming a stable complete event schema.
 * Only completed Shell call fields needed by the feasibility decision are projected.
 */
export function parseStreamJsonTranscript(transcript) {
  const events = []
  let malformedLineCount = 0
  for (const line of transcript.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      malformedLineCount += 1
    }
  }

  const terminal = [...events].reverse().find((event) => event?.type === 'result')
  return {
    eventCount: events.length,
    malformedLineCount,
    terminalResult: terminal
      ? {
          subtype: terminal.subtype ?? null,
          isError: terminal.is_error ?? terminal.isError ?? null,
        }
      : null,
    shellCalls: events.flatMap((event) =>
      event?.type === 'tool_call' && event.subtype === 'completed' ? shellToolCalls(event) : [],
    ),
  }
}

/** Return true only for the documented, complete authenticated status response. */
export function isExplicitlyAuthenticated(result) {
  if (result.code !== 0) return false
  try {
    const status = JSON.parse(result.stdout)
    return status?.isAuthenticated === true && status.status === 'authenticated'
  } catch {
    return false
  }
}

function redactForCommittedSummary(value) {
  return String(value)
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu, '<redacted-email>')
    .replace(/\/(?:Users|home)\/[^/\s"']+/gu, (match) =>
      match.startsWith('/Users/') ? '/Users/<redacted>' : '/home/<redacted>',
    )
    .replace(/\b(?:sk|pk|cursor)[_-][A-Za-z0-9_-]{12,}\b/giu, '<redacted-token>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, '<redacted-id>')
}

async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function userCursorHooksFingerprint() {
  try {
    await access(USER_CURSOR_HOOKS_PATH)
    // Stream only into SHA-256: neither hook commands nor account data are copied into evidence.
    return { exists: true, sha256: await sha256File(USER_CURSOR_HOOKS_PATH) }
  } catch {
    return { exists: false, sha256: null }
  }
}

/**
 * Capture child output in memory for parsing while simultaneously writing it to evidence files.
 * The files are therefore useful even if the process later times out.
 */
export function runCommandCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutFile = options.stdoutPath
      ? createWriteStream(options.stdoutPath, { mode: 0o600 })
      : null
    const stderrFile = options.stderrPath
      ? createWriteStream(options.stderrPath, { mode: 0o600 })
      : null
    const stdout = []
    const stderr = []
    let timedOut = false
    let settled = false
    let forceKill = null
    const terminate = (signal) => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // Fall through to the direct child if no separate process group exists yet.
        }
      }
      child.kill(signal)
    }
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          terminate('SIGTERM')
          forceKill = setTimeout(() => terminate('SIGKILL'), 1_000)
        }, options.timeoutMs)
      : null
    const settle = async ({ code, signal, error }) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      stdoutFile?.end()
      stderrFile?.end()
      await Promise.all(
        [stdoutFile, stderrFile].filter(Boolean).map((stream) => finished(stream).catch(() => {})),
      )
      resolve({
        code,
        signal,
        error,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    }
    child.stdout.on('data', (chunk) => {
      const buffer = Buffer.from(chunk)
      stdout.push(buffer)
      stdoutFile?.write(buffer)
    })
    child.stderr.on('data', (chunk) => {
      const buffer = Buffer.from(chunk)
      stderr.push(buffer)
      stderrFile?.write(buffer)
    })
    child.on('error', (error) => settle({ code: null, signal: null, error: error.message }))
    child.on('close', (code, signal) => settle({ code, signal, error: null }))
  })
}

export function createProbeHookProgram() {
  return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'

const [phase, mode, nonce, originalB64, mediatedB64, eventLog] = process.argv.slice(2)
const original = Buffer.from(originalB64, 'base64url').toString('utf8')
const mediated = Buffer.from(mediatedB64, 'base64url').toString('utf8')
const log = (record) => appendFileSync(eventLog, JSON.stringify({ timestamp: new Date().toISOString(), phase, mode, nonce, ...record }) + '\\n', { mode: 0o600 })
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { raw += chunk })
process.stdin.on('end', () => {
  let input
  try { input = raw ? JSON.parse(raw) : {} } catch { input = { malformedInput: raw } }
  const command = input.command ?? input.tool_input?.command ?? input.toolInput?.command ?? input.input?.command ?? ''
  log({ input, command })
  const deny = { permission: 'deny', user_message: 'probe denies non-nonce command' }
  const respond = (response) => { log({ output: response }); process.stdout.write(JSON.stringify(response)) }
  if (command !== original && command !== mediated) {
    respond(deny)
    return
  }
  if (mode === 'malformed') {
    appendFileSync(eventLog, JSON.stringify({ timestamp: new Date().toISOString(), phase, mode, output: '{malformed' }) + '\\n', { mode: 0o600 })
    process.stdout.write('{malformed')
    return
  }
  if (mode === 'nonzero') {
    log({ output: 'nonzero exit 19' })
    process.exitCode = 19
    return
  }
  let response
  if (mode === 'deny') response = { permission: 'deny', user_message: 'probe denies all commands in this case' }
  else if (phase === 'preToolUse' && command === original) response = { permission: 'allow', updated_input: { command: mediated } }
  else if (command === mediated) response = { permission: 'allow' }
  else response = deny
  respond(response)
})
`
}

function commandForMarker(markerPath, markerValue, stdoutMarker, stderrMarker, exitCode) {
  const statements = [
    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(markerValue)})`,
  ]
  if (stdoutMarker) statements.push(`process.stdout.write(${JSON.stringify(`${stdoutMarker}\n`)})`)
  if (stderrMarker) statements.push(`process.stderr.write(${JSON.stringify(`${stderrMarker}\n`)})`)
  if (exitCode !== 0) statements.push(`process.exit(${exitCode})`)
  return `node -e ${shellQuote(statements.join('; '))}`
}

async function writeHooks({ caseDir, caseName, nonce, mode, competing = false }) {
  const hooksDir = path.join(caseDir, '.cursor')
  const hookPath = path.join(caseDir, 'probe-hook.mjs')
  const eventLog = path.join(caseDir, 'hook-events.ndjson')
  const originalMarker = path.join(caseDir, 'ORIGINAL_RAN')
  const mediatedMarker = path.join(caseDir, 'MEDIATED_RAN')
  const thirdMarker = path.join(caseDir, 'THIRD_RAN')
  const stdoutMarker = `${PROBE_PREFIX}_STDOUT_${nonce}`
  const stderrMarker = `${PROBE_PREFIX}_STDERR_${nonce}`
  const original = commandForMarker(originalMarker, nonce, '', '', 0)
  const mediated = commandForMarker(
    mediatedMarker,
    nonce,
    caseName === 'B' ? '' : stdoutMarker,
    caseName === 'B' ? stderrMarker : '',
    caseName === 'B' ? 37 : 0,
  )
  const competingCommand = commandForMarker(
    thirdMarker,
    nonce,
    `${PROBE_PREFIX}_THIRD_${nonce}`,
    '',
    0,
  )
  const hookCommand = (phase, hookMode, replacement) =>
    [
      shellQuote(process.execPath),
      shellQuote(hookPath),
      shellQuote(phase),
      shellQuote(hookMode),
      shellQuote(nonce),
      shellQuote(Buffer.from(original).toString('base64url')),
      shellQuote(Buffer.from(replacement).toString('base64url')),
      shellQuote(eventLog),
    ].join(' ')

  await mkdir(hooksDir, { recursive: true, mode: 0o700 })
  await writeFile(hookPath, createProbeHookProgram(), { mode: 0o700 })
  const preToolUse = [{ matcher: 'Shell', command: hookCommand('preToolUse', mode, mediated) }]
  if (competing) {
    preToolUse.push({
      matcher: 'Shell',
      command: hookCommand('preToolUse', 'competing', competingCommand),
    })
  }
  await writeFile(
    path.join(hooksDir, 'hooks.json'),
    `${JSON.stringify(
      {
        version: 1,
        hooks: {
          preToolUse,
          beforeShellExecution: [{ command: hookCommand('beforeShellExecution', mode, mediated) }],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return {
    original,
    stdoutMarker,
    stderrMarker,
    paths: { eventLog, originalMarker, mediatedMarker, thirdMarker },
  }
}

async function markerState(paths) {
  const state = {}
  for (const [name, markerPath] of Object.entries(paths)) {
    if (!name.endsWith('Marker')) continue
    try {
      await stat(markerPath)
      state[name.replace('Marker', '')] = true
    } catch {
      state[name.replace('Marker', '')] = false
    }
  }
  return state
}

async function runCase(evidenceDir, caseName, configuration) {
  const nonce = randomBytes(16).toString('hex')
  const caseDir = path.join(evidenceDir, `case-${caseName.toLowerCase()}`)
  await mkdir(caseDir, { recursive: true, mode: 0o700 })
  const setup = await writeHooks({ caseDir, caseName, nonce, ...configuration })
  const prompt = [
    'This is a controlled Cursor Shell hook transport probe.',
    'Run exactly the following Shell command once and do not inspect, edit, retry, or run any other command:',
    setup.original,
  ].join('\n')
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--trust',
    '--workspace',
    caseDir,
    prompt,
  ]
  const startedAt = new Date().toISOString()
  const result = await runCommandCapture('cursor-agent', args, {
    cwd: caseDir,
    stdoutPath: path.join(caseDir, 'cursor-stdout.ndjson'),
    stderrPath: path.join(caseDir, 'cursor-stderr.log'),
    timeoutMs: CASE_TIMEOUT_MS,
  })
  const finishedAt = new Date().toISOString()
  const hooks = await readFile(setup.paths.eventLog, 'utf8').catch(() => '')
  const summary = {
    case: caseName,
    startedAt,
    finishedAt,
    command: ['cursor-agent', ...args.slice(0, -1), '<controlled prompt>'],
    exit: {
      code: result.code,
      signal: result.signal,
      spawnError: result.error,
      timedOut: result.timedOut,
    },
    stream: parseStreamJsonTranscript(result.stdout),
    markers: await markerState(setup.paths),
    expectedMarkers: { stdout: setup.stdoutMarker, stderr: setup.stderrMarker },
    hookInvocationCount: hooks.split(/\r?\n/u).filter(Boolean).length,
  }
  await writeFile(
    path.join(caseDir, 'case-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    {
      mode: 0o600,
    },
  )
  return summary
}

async function rawEvidenceManifest(evidenceDir) {
  const entries = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(fullPath)
      else if (entry.isFile() && entry.name !== 'evidence-manifest.json') {
        entries.push({
          path: path.relative(evidenceDir, fullPath),
          sha256: await sha256File(fullPath),
        })
      }
    }
  }
  await visit(evidenceDir)
  entries.sort((left, right) => left.path.localeCompare(right.path))
  const serialized = `${JSON.stringify(entries, null, 2)}\n`
  await writeFile(path.join(evidenceDir, 'evidence-manifest.json'), serialized, { mode: 0o600 })
  return createHash('sha256').update(serialized).digest('hex')
}

export function renderResultSpec(summary) {
  return `# Cursor Shell rewrite probe result\n\n- Status: **PENDING REVIEW** — live evidence is captured, but this Task 1 harness does not make a GO/NO-GO/BLOCKED decision.\n- Cursor version: \`${redactForCommittedSummary(summary.cursorVersion)}\`\n- OS: \`${redactForCommittedSummary(summary.os)}\`\n- Invocation: \`cursor-agent --print --output-format stream-json --trust --workspace <private temporary workspace> <controlled prompt>\`\n- Raw-evidence manifest SHA-256: \`${summary.rawEvidenceManifestHash}\`\n- User-level \`.cursor/hooks.json\`: ${summary.userHooks.exists ? `present (SHA-256 \`${summary.userHooks.sha256}\`)` : 'absent'}; contents were not read into committed output or modified.\n\n## Captured cases\n\n${summary.cases
    .map(
      (item) =>
        `- Case ${item.case}: process exit ${item.exit.code ?? 'spawn-error'}; timed out ${item.exit.timedOut}; markers ${JSON.stringify(item.markers)}; ${item.hookInvocationCount} hook log entries; stream events ${item.stream.eventCount}, malformed lines ${item.stream.malformedLineCount}.`,
    )
    .join(
      '\n',
    )}\n\nRaw Cursor streams, hook inputs/outputs, preflight status, and timestamps remain only in the private evidence directory printed by the probe. They are deliberately not committed because they may contain local paths, account identity, session identifiers, or tokens.\n`
}

async function main() {
  const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-shell-rewrite-probe-'))
  await chmod(evidenceDir, 0o700)
  const createdAt = new Date().toISOString()
  console.log(`Cursor Shell rewrite probe evidence directory: ${evidenceDir}`)
  const userHooks = await userCursorHooksFingerprint()
  await writeFile(
    path.join(evidenceDir, 'user-cursor-hooks-fingerprint.json'),
    `${JSON.stringify(userHooks)}\n`,
    {
      mode: 0o600,
    },
  )

  const version = await runCommandCapture('cursor-agent', ['--version'], {
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  })
  await writeFile(
    path.join(evidenceDir, 'cursor-version.log'),
    `${version.stdout}${version.stderr}`,
    { mode: 0o600 },
  )
  if (version.error || version.code !== 0) {
    await writeFile(
      path.join(evidenceDir, 'preflight.json'),
      `${JSON.stringify({ createdAt, version: { code: version.code, error: version.error } }, null, 2)}\n`,
      { mode: 0o600 },
    )
    console.log(
      'SKIP: cursor-agent is not present; no production or user Cursor configuration was changed.',
    )
    return 0
  }

  const authentication = await runCommandCapture('cursor-agent', ['status', '--format', 'json'], {
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  })
  await writeFile(
    path.join(evidenceDir, 'cursor-authentication-status.log'),
    `${authentication.stdout}${authentication.stderr}`,
    {
      mode: 0o600,
    },
  )
  await writeFile(
    path.join(evidenceDir, 'preflight.json'),
    `${JSON.stringify(
      {
        createdAt,
        version: { code: version.code, error: version.error },
        authentication: { code: authentication.code, error: authentication.error },
      },
      null,
    )}\n`,
    { mode: 0o600 },
  )
  if (!isExplicitlyAuthenticated(authentication)) {
    console.log(
      'SKIP: cursor-agent is not authenticated; no production or user Cursor configuration was changed.',
    )
    return 0
  }

  const cases = []
  cases.push(await runCase(evidenceDir, 'A', { mode: 'normal' }))
  cases.push(await runCase(evidenceDir, 'B', { mode: 'normal' }))
  cases.push(await runCase(evidenceDir, 'C', { mode: 'normal' }))
  cases.push(await runCase(evidenceDir, 'D', { mode: 'normal', competing: true }))
  cases.push(await runCase(evidenceDir, 'E-deny', { mode: 'deny' }))
  cases.push(await runCase(evidenceDir, 'E-malformed', { mode: 'malformed' }))
  cases.push(await runCase(evidenceDir, 'E-nonzero', { mode: 'nonzero' }))

  const rawEvidenceManifestHash = await rawEvidenceManifest(evidenceDir)
  const summary = {
    cursorVersion: version.stdout.trim() || version.stderr.trim(),
    os: `${process.platform} ${os.release()} ${process.arch}`,
    userHooks,
    rawEvidenceManifestHash,
    cases,
  }
  const committedSummary = renderResultSpec(summary)
  await writeFile(path.join(evidenceDir, 'redacted-result-summary.md'), committedSummary, {
    mode: 0o600,
  })
  await writeFile(RESULT_SPEC_PATH, committedSummary, 'utf8')
  console.log(
    `Probe finished. Redacted summary copied to ${path.relative(REPOSITORY_ROOT, RESULT_SPEC_PATH)}.`,
  )
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().then(
    (exitCode) => process.exit(exitCode),
    (error) => {
      console.error(
        `Probe failed before a result could be recorded: ${error.stack ?? error.message}`,
      )
      process.exit(1)
    },
  )
}
