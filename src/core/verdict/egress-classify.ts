/**
 * Egress tool classification (SPEC v2.1.3 R33–R34).
 * destructive → ask | read → allow at egress layer | ambiguous → require_approval via PolicyEngine
 */

import path from 'node:path'

import type { ShellEffectRequirement } from '../effect-ir/shell-build.js'
import { parseNetworkEndpoint } from '../network-endpoint.js'

export type EgressClassification = 'destructive' | 'read' | 'ambiguous'

export interface DecodeEgressEffectsParams {
  tokens: string[]
  cwd: string
  segment: string
}

const EGRESS_TOOL_HEADS = new Set([
  'aws',
  'curl',
  'gh',
  'gcloud',
  'heroku',
  'kubectl',
  'netlify',
  'vercel',
  'wget',
])

const READ_VERB_PATTERN = /\b(ls|list|describe|get|view|logs|status|top|head|explain)\b/

const CURL_DATA_FLAGS = new Set(['-d', '-F', '-T', '--post-data', '--post-file', '--upload-file'])

const CURL_DATA_PREFIXES = ['--data', '--form', '--upload-file', '--post-']

const CURL_EFFECT_NEUTRAL_FLAGS = new Set([
  '-f',
  '-L',
  '-s',
  '-S',
  '--fail',
  '--fail-with-body',
  '--location',
  '--show-error',
  '--silent',
])

const SECRET_VALUE_PATTERN =
  /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL)[A-Za-z0-9_]*\}?|(?:^|[/\\])\.env(?:\.|$)|credentials?|secrets?|id_rsa|\.pem\b)/i

const GH_READ_COMMANDS = new Set([
  'api',
  'auth status',
  'issue list',
  'issue status',
  'issue view',
  'pr checks',
  'pr diff',
  'pr list',
  'pr status',
  'pr view',
  'release list',
  'release view',
  'repo list',
  'repo view',
  'run list',
  'run view',
  'search code',
  'workflow list',
  'workflow view',
])

const KUBECTL_DESTRUCTIVE = new Set([
  'apply',
  'cordon',
  'create',
  'delete',
  'drain',
  'exec',
  'patch',
  'replace',
  'rollout',
  'scale',
])

const KUBECTL_READ = new Set(['describe', 'get', 'logs', 'top'])

export function isEgressToolHead(head: string): boolean {
  return EGRESS_TOOL_HEADS.has(head)
}

export function classifyEgressTool(head: string, tokens: string[]): EgressClassification | null {
  if (!EGRESS_TOOL_HEADS.has(head)) {
    return null
  }
  if (head === 'curl' || head === 'wget') {
    return classifyCurlWget(tokens)
  }
  if (head === 'aws') {
    return classifyAws(tokens)
  }
  if (head === 'gh') {
    return classifyGh(tokens)
  }
  if (head === 'gcloud') {
    return classifyGcloud(tokens)
  }
  if (head === 'kubectl') {
    return classifyKubectl(tokens)
  }
  if (head === 'heroku') {
    return classifyHeroku(tokens)
  }
  if (head === 'vercel') {
    return classifyVercel(tokens)
  }
  if (head === 'netlify') {
    return classifyNetlify(tokens)
  }
  return 'ambiguous'
}

/**
 * Decode curl/wget/gh grammar into typed effects. This API deliberately has no
 * permission or verdict output; uncertainty is represented by indeterminate
 * requirements alongside every effect that was still recoverable.
 */
export function decodeEgressEffects(
  params: DecodeEgressEffectsParams,
): ShellEffectRequirement[] | null {
  const head = path.basename(params.tokens[0] ?? '')
  if (head !== 'curl' && head !== 'wget' && head !== 'gh') {
    return null
  }

  const decoded =
    head === 'gh' ? decodeGhGrammar(params.tokens) : decodeCurlWgetGrammar(head, params.tokens)
  const provenance = { segment: params.segment }
  const requirements: ShellEffectRequirement[] = []

  for (const file of decoded.files) {
    const resolved = path.resolve(params.cwd, expandHome(file))
    requirements.push(
      requirement('fs.read', 'fs.read', { kind: 'path', path: resolved }, params.segment, [
        'egress.explicit_file_read',
      ]),
    )
    if (
      decoded.secretFiles.includes(file) ||
      (!decoded.nonSecretFiles.includes(file) && isSecretValue(file))
    ) {
      requirements.push(
        requirement(
          'secret.read',
          'secret.read',
          { kind: 'path', path: resolved },
          params.segment,
          ['egress.explicit_secret_payload'],
        ),
      )
    }
  }
  for (const file of decoded.outputFiles) {
    if (file === '-') {
      continue
    }
    const resolved = path.resolve(params.cwd, expandHome(file))
    if (resolved === '/dev/null') {
      continue
    }
    requirements.push(
      requirement('fs.write', 'fs.write', { kind: 'path', path: resolved }, params.segment, [
        'egress.output_write',
      ]),
    )
    if (
      /^(?:\/etc(?:\/|$)|\/var\/run(?:\/|$)|.*(?:^|[/\\])\.(?:git|ssh|cursor|claude)(?:[/\\]|$))/.test(
        resolved,
      )
    ) {
      requirements.push(
        requirement(
          'control_plane.write',
          'control_plane.write',
          { kind: 'path', path: resolved },
          params.segment,
          ['egress.output_write', 'protected_path'],
        ),
      )
    }
  }
  if (decoded.secretRead) {
    requirements.push(
      requirement('secret.read', 'secret.read', { kind: 'unknown' }, params.segment, [
        'egress.ambient_secret_read',
      ]),
    )
  }
  if (decoded.ambientWrite) {
    requirements.push(
      requirement('fs.write', 'fs.write', { kind: 'unknown' }, params.segment, [
        'egress.ambient_write',
      ]),
    )
  }
  for (const command of decoded.processSpawns ?? []) {
    requirements.push(
      requirement(
        'process.exec',
        'process.exec',
        { kind: 'executable', command, operation: 'spawn' },
        params.segment,
        ['egress.external_process_spawn'],
      ),
    )
  }

  if (
    decoded.transfers.some((transfer) => transfer.payload === 'secret') &&
    !requirements.some((entry) => entry.tag === 'secret.read')
  ) {
    requirements.push(
      requirement('secret.read', 'secret.read', { kind: 'unknown' }, params.segment, [
        'egress.explicit_secret_payload',
      ]),
    )
  }

  for (const transfer of decoded.transfers) {
    requirements.push({
      ...requirement(
        'network.connect',
        'network.connect',
        {
          kind: 'network',
          ...transfer.endpoint,
          mode: transfer.mode,
          payload: transfer.payload,
        },
        params.segment,
        decoded.signals,
      ),
      provenance,
    })
  }

  if (!decoded.complete || decoded.transfers.length === 0) {
    requirements.push(
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, params.segment, [
        ...decoded.signals,
        decoded.transfers.length > 0 ? 'egress.grammar_incomplete' : 'egress.endpoint_unknown',
      ]),
    )
  }
  return requirements
}

interface EgressGrammar {
  transfers: Array<{
    endpoint: NonNullable<ReturnType<typeof parseNetworkEndpoint>>
    mode: 'read' | 'mutate' | 'ambiguous'
    payload: 'none' | 'present' | 'secret'
  }>
  mode: 'read' | 'mutate' | 'ambiguous'
  payload: 'none' | 'present' | 'secret'
  files: string[]
  secretFiles: string[]
  nonSecretFiles: string[]
  outputFiles: string[]
  secretRead?: boolean
  ambientWrite?: boolean
  processSpawns?: string[]
  complete: boolean
  signals: string[]
}

const CURL_OPTIONS_WITH_SEPARATE_VALUES = new Set([
  '-A',
  '-D',
  '-F',
  '-H',
  '-K',
  '-T',
  '-X',
  '-b',
  '-c',
  '-d',
  '-e',
  '-o',
  '-u',
  '-w',
  '--cacert',
  '--cert',
  '--config',
  '--connect-timeout',
  '--connect-to',
  '--cookie',
  '--cookie-jar',
  '--data',
  '--data-ascii',
  '--data-binary',
  '--data-raw',
  '--dump-header',
  '--form',
  '--header',
  '--interface',
  '--key',
  '--limit-rate',
  '--max-time',
  '--output',
  '--output-dir',
  '--proxy',
  '--referer',
  '--request',
  '--resolve',
  '--retry',
  '--retry-delay',
  '--upload-file',
  '--url',
  '--user',
  '--user-agent',
  '--write-out',
])

function decodeCurlWgetGrammar(head: 'curl' | 'wget', tokens: string[]): EgressGrammar {
  if (head !== 'curl' || !tokens.includes('--next')) {
    return decodeSingleCurlWgetGrammar(head, tokens)
  }
  const scopes: string[][] = [[]]
  const args = tokens.slice(1)
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ''
    if (token === '--next') {
      scopes.push([])
    } else {
      scopes.at(-1)?.push(token)
      if (CURL_OPTIONS_WITH_SEPARATE_VALUES.has(token) && args[index + 1] !== undefined) {
        scopes.at(-1)?.push(args[index + 1] ?? '')
        index += 1
      }
    }
  }
  const decodedScopes = scopes.map((scope) => decodeSingleCurlWgetGrammar(head, [head, ...scope]))
  const mode = mergeTransferModes(decodedScopes.flatMap((scope) => scope.transfers))
  const payload = decodedScopes.reduce<EgressGrammar['payload']>(
    (current, scope) => mergePayload(current, scope.payload),
    'none',
  )
  return {
    transfers: decodedScopes.flatMap((scope) => scope.transfers),
    mode,
    payload,
    files: [...new Set(decodedScopes.flatMap((scope) => scope.files))],
    secretFiles: [...new Set(decodedScopes.flatMap((scope) => scope.secretFiles))],
    nonSecretFiles: [...new Set(decodedScopes.flatMap((scope) => scope.nonSecretFiles))],
    outputFiles: [...new Set(decodedScopes.flatMap((scope) => scope.outputFiles))],
    complete:
      scopes.every((scope) => scope.length > 0) &&
      decodedScopes.every((scope) => scope.complete && scope.transfers.length > 0),
    signals: [
      'egress.curl',
      'egress.curl.transfer_scopes',
      `egress.mode.${mode}`,
      `egress.payload.${payload}`,
    ],
  }
}

function decodeSingleCurlWgetGrammar(head: 'curl' | 'wget', tokens: string[]): EgressGrammar {
  let mode: EgressGrammar['mode'] = 'read'
  let payload: EgressGrammar['payload'] = 'none'
  let complete = true
  const files: string[] = []
  const secretFiles: string[] = []
  const nonSecretFiles: string[] = []
  const outputFiles: string[] = []
  const directoryEligibleOutputs = new Set<string>()
  let remoteNameOutput = false
  let explicitOutput = false
  let outputDirectory: string | null = null
  const args = tokens.slice(1)
  const endpoints: Array<NonNullable<ReturnType<typeof parseNetworkEndpoint>>> = []
  const endpointOutputNames: string[] = []
  const methodFlags = head === 'curl' ? ['-X', '--request'] : ['--method']
  const bodyDataFlags =
    head === 'curl'
      ? ['-d', '--data', '--data-ascii', '--data-binary', '--data-raw']
      : ['--body-data', '--post-data']
  const bodyFileFlags = head === 'curl' ? ['-T', '--upload-file'] : ['--body-file', '--post-file']
  const formFlags = head === 'curl' ? ['-F', '--form'] : []
  const valueOnlyFlags =
    head === 'curl'
      ? [
          '-A',
          '-D',
          '-H',
          '-b',
          '-c',
          '-e',
          '-o',
          '-u',
          '-w',
          '--cacert',
          '--cert',
          '--connect-timeout',
          '--connect-to',
          '--cookie',
          '--cookie-jar',
          '--dump-header',
          '--header',
          '--interface',
          '--key',
          '--limit-rate',
          '--max-time',
          '--output',
          '--output-dir',
          '--proxy',
          '--referer',
          '--resolve',
          '--retry',
          '--retry-delay',
          '--user',
          '--user-agent',
          '--write-out',
        ]
      : [
          '-O',
          '-P',
          '-a',
          '-o',
          '--append-output',
          '--bind-address',
          '--ca-certificate',
          '--certificate',
          '--directory-prefix',
          '--header',
          '--output-document',
          '--output-file',
          '--password',
          '--private-key',
          '--referer',
          '--timeout',
          '--tries',
          '--user',
          '--user-agent',
          '--wait',
        ]

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ''
    const next = args[index + 1] ?? ''
    if (
      head === 'curl' &&
      (CURL_EFFECT_NEUTRAL_FLAGS.has(token) ||
        (/^-[fLsS]+$/.test(token) &&
          [...token.slice(1)].every((flag) => CURL_EFFECT_NEUTRAL_FLAGS.has(`-${flag}`))))
    ) {
      continue
    }
    if (head === 'curl' && (token === '-I' || token === '--head')) {
      continue
    }
    if (head === 'curl' && (token === '-O' || token === '--remote-name')) {
      remoteNameOutput = true
      explicitOutput = true
      continue
    }
    const directoryFlags = head === 'curl' ? ['--output-dir'] : ['-P', '--directory-prefix']
    if (directoryFlags.includes(token)) {
      if (!next || next.startsWith('-')) {
        complete = false
      } else {
        outputDirectory = next
        index += 1
      }
      continue
    }
    const directoryValue = optionValue(token, next, directoryFlags)
    if (directoryValue) {
      outputDirectory = directoryValue.value
      continue
    }
    const method = optionValue(token, next, methodFlags)
    if (method) {
      if (!/^[A-Za-z]+$/.test(method.value) || method.value.includes('$')) {
        mode = 'ambiguous'
        complete = false
      } else {
        const normalized = method.value.toUpperCase()
        mode = normalized === 'GET' || normalized === 'HEAD' ? 'read' : 'mutate'
      }
      if (method.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, methodFlags)) {
      mode = 'ambiguous'
      complete = false
      continue
    }

    const bodyData = optionValue(token, next, bodyDataFlags)
    if (bodyData) {
      mode = mode === 'ambiguous' ? 'ambiguous' : 'mutate'
      const dataFile = bodyData.value.startsWith('@') ? bodyData.value.slice(1) : null
      if (dataFile) {
        files.push(dataFile)
      }
      payload = mergePayload(payload, isSecretValue(bodyData) ? 'secret' : 'present')
      if (bodyData.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, bodyDataFlags)) {
      mode = 'ambiguous'
      complete = false
      continue
    }

    const bodyFile = optionValue(token, next, bodyFileFlags)
    if (bodyFile) {
      mode = mode === 'ambiguous' ? 'ambiguous' : 'mutate'
      payload = mergePayload(payload, isSecretValue(bodyFile) ? 'secret' : 'present')
      if (bodyFile.value !== '-') {
        files.push(bodyFile.value.replace(/^@/, ''))
      }
      if (bodyFile.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, bodyFileFlags)) {
      mode = 'ambiguous'
      complete = false
      continue
    }

    const form = optionValue(token, next, formFlags)
    if (form) {
      mode = mode === 'ambiguous' ? 'ambiguous' : 'mutate'
      payload = mergePayload(payload, isSecretValue(form) ? 'secret' : 'present')
      const formFile = uploadFileOperand(form)
      if (formFile) {
        files.push(formFile)
      }
      if (form.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, formFlags)) {
      mode = 'ambiguous'
      complete = false
      continue
    }

    const configValue = optionValue(token, next, ['-K', '--config'])
    if (configValue) {
      files.push(configValue.value)
      complete = false
      if (configValue.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, ['-K', '--config'])) {
      complete = false
      continue
    }

    const outputFlags =
      head === 'curl'
        ? ['-o', '--output', '-c', '--cookie-jar', '-D', '--dump-header']
        : ['-O', '--output-document']
    const outputValue = optionValue(token, next, outputFlags)
    if (outputValue) {
      outputFiles.push(outputValue.value)
      if (head === 'curl' && matchesAnyOption(token, ['-o', '--output'])) {
        directoryEligibleOutputs.add(outputValue.value)
      }
      explicitOutput = true
      if (outputValue.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, outputFlags)) {
      complete = false
      continue
    }

    const credentialFlags =
      head === 'curl'
        ? ['--key', '--cert', '--cacert']
        : ['--private-key', '--certificate', '--ca-certificate']
    const credential = optionValue(token, next, credentialFlags)
    if (credential) {
      files.push(credential.value)
      if (
        token === '--key' ||
        token.startsWith('--key=') ||
        token === '--cert' ||
        token.startsWith('--cert=') ||
        token === '--private-key' ||
        token.startsWith('--private-key=') ||
        token === '--certificate' ||
        token.startsWith('--certificate=')
      ) {
        secretFiles.push(credential.value)
      } else {
        nonSecretFiles.push(credential.value)
      }
      if (credential.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, credentialFlags)) {
      complete = false
      continue
    }

    const cookie = head === 'curl' ? optionValue(token, next, ['-b', '--cookie']) : null
    if (cookie) {
      if (!cookie.value.includes('=')) {
        files.push(cookie.value)
        secretFiles.push(cookie.value)
        payload = 'secret'
      }
      if (cookie.fromNext) {
        index += 1
      }
      continue
    }

    const header = optionValue(token, next, ['-H', '--header'])
    if (header) {
      mode = mode === 'ambiguous' ? 'ambiguous' : 'mutate'
      if (header.value.startsWith('@')) {
        const headerFile = header.value.slice(1)
        files.push(headerFile)
        payload = mergePayload(payload, isSecretValue(headerFile) ? 'secret' : 'present')
      } else if (
        /^\s*(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-token|token)\s*:\s*.+/i.test(
          header.value,
        )
      ) {
        payload = 'secret'
      } else {
        payload = mergePayload(
          payload,
          isExplicitSecretInterpolation(header.value) ? 'secret' : 'present',
        )
      }
      if (header.fromNext) {
        index += 1
      }
      continue
    }

    const urlValue = head === 'curl' ? optionValue(token, next, ['--url']) : null
    if (urlValue) {
      const endpoint = parseNetworkEndpoint(urlValue.value)
      if (endpoint) {
        endpoints.push(endpoint)
        endpointOutputNames.push(remoteOutputName(urlValue.value))
        if (isSecretValue(urlValue.value)) {
          payload = 'secret'
        }
      } else {
        complete = false
      }
      if (urlValue.fromNext) {
        index += 1
      }
      continue
    }

    const skippedValue = optionValue(token, next, valueOnlyFlags)
    if (skippedValue) {
      if (isExplicitSecretInterpolation(skippedValue.value)) {
        mode = mode === 'ambiguous' ? 'ambiguous' : 'mutate'
        payload = 'secret'
      }
      if (skippedValue.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, valueOnlyFlags)) {
      complete = false
      continue
    }

    if (isExplicitSecretInterpolation(token)) {
      mode = mode === 'ambiguous' ? 'ambiguous' : 'mutate'
      payload = 'secret'
    }

    const parsed = parseNetworkEndpoint(token)
    if (parsed) {
      endpoints.push(parsed)
      endpointOutputNames.push(remoteOutputName(token))
      if (isSecretValue(token)) {
        payload = 'secret'
      }
      continue
    }
    if (token.startsWith('-') && token !== '-') {
      complete = false
    }
  }

  if (head === 'wget' && !explicitOutput) {
    outputFiles.push(
      ...endpointOutputNames.map((name) =>
        outputDirectory ? path.join(outputDirectory, name) : name,
      ),
    )
  } else if (head === 'curl' && remoteNameOutput) {
    outputFiles.push(
      ...endpointOutputNames.map((name) =>
        outputDirectory ? path.join(outputDirectory, name) : name,
      ),
    )
  }

  return {
    transfers: endpoints.map((endpoint) => ({ endpoint, mode, payload })),
    mode,
    payload,
    files: [...new Set(files)],
    secretFiles: [...new Set(secretFiles)],
    nonSecretFiles: [...new Set(nonSecretFiles)],
    outputFiles: [
      ...new Set(
        outputFiles.map((file) =>
          outputDirectory && directoryEligibleOutputs.has(file) && !path.isAbsolute(file)
            ? path.join(outputDirectory, file)
            : file,
        ),
      ),
    ],
    complete,
    signals: [`egress.${head}`, `egress.mode.${mode}`, `egress.payload.${payload}`],
  }
}

function remoteOutputName(spec: string): string {
  let pathname = ''
  try {
    pathname = new URL(spec).pathname
  } catch {
    pathname = spec.split(/[?#]/, 1)[0] ?? ''
  }
  const name = path.posix.basename(pathname)
  return name && name !== '/' ? name : 'index.html'
}

function decodeGhGrammar(tokens: string[]): EgressGrammar {
  const args = tokens.slice(1)
  const hostnameIndex = args.findIndex(
    (token) => token === '--hostname' || token.startsWith('--hostname='),
  )
  const hostnameToken = hostnameIndex >= 0 ? (args[hostnameIndex] ?? '') : ''
  const hostnameMissing =
    hostnameToken === '--hostname' &&
    (!args[hostnameIndex + 1] || (args[hostnameIndex + 1] ?? '').startsWith('-'))
  const host = hostnameMissing
    ? null
    : hostnameToken === '--hostname'
      ? (args[hostnameIndex + 1] ?? null)
      : hostnameToken.startsWith('--hostname=')
        ? hostnameToken.slice('--hostname='.length) || null
        : 'api.github.com'
  const endpoint = host ? parseNetworkEndpoint(`https://${host}`) : null
  const commandTokens = args.filter((token, index) => {
    if (
      index === hostnameIndex ||
      (hostnameToken === '--hostname' && index === hostnameIndex + 1)
    ) {
      return false
    }
    return !token.startsWith('-')
  })
  const command =
    commandTokens[0] === 'api'
      ? 'api'
      : `${commandTokens[0] ?? ''} ${commandTokens[1] ?? ''}`.trim()
  let mode: EgressGrammar['mode'] = GH_READ_COMMANDS.has(command) ? 'read' : 'ambiguous'
  let payload: EgressGrammar['payload'] = 'none'
  let complete = mode !== 'ambiguous' && !hostnameMissing && Boolean(endpoint)
  const files: string[] = []
  let secretRead = false
  let ambientWrite = false
  const processSpawns: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ''
    const next = args[index + 1] ?? ''
    if (token === '--show-token' && command === 'auth status') {
      secretRead = true
      continue
    }
    if (token === '--web' && command !== 'api') {
      processSpawns.push('browser')
      continue
    }
    const cache = optionValue(token, next, ['--cache'])
    if (cache) {
      ambientWrite = true
      if (cache.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, ['--cache'])) {
      complete = false
      continue
    }
    const header = optionValue(token, next, ['-H', '--header'])
    if (header) {
      payload =
        /^\s*(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-token|token)\s*:\s*.+/i.test(
          header.value,
        ) || isExplicitSecretInterpolation(header.value)
          ? 'secret'
          : mergePayload(payload, 'present')
      if (header.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, ['-H', '--header'])) {
      complete = false
      continue
    }
    const method = optionValue(token, next, ['-X', '--method'])
    if (method) {
      if (!method.value || method.value.includes('$')) {
        mode = 'ambiguous'
        complete = false
      } else {
        const normalized = method.value.toUpperCase()
        mode = normalized === 'GET' || normalized === 'HEAD' ? 'read' : 'mutate'
      }
      if (method.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, ['-X', '--method'])) {
      mode = 'ambiguous'
      complete = false
      continue
    }
    const body = optionValue(token, next, ['-f', '-F', '--field', '--raw-field', '--input'])
    if (body) {
      mode = 'mutate'
      payload = isSecretValue(body.value) ? 'secret' : 'present'
      if (token === '--input' || token.startsWith('--input=')) {
        files.push(body.value)
      }
      if (body.fromNext) {
        index += 1
      }
      continue
    }
    if (matchesAnyOption(token, ['-f', '-F', '--field', '--raw-field', '--input'])) {
      mode = 'ambiguous'
      complete = false
    }
  }

  return {
    transfers: endpoint ? [{ endpoint, mode, payload }] : [],
    mode,
    payload,
    files,
    secretFiles: [],
    nonSecretFiles: [],
    outputFiles: [],
    secretRead,
    ambientWrite,
    processSpawns,
    complete,
    signals: ['egress.gh', `egress.mode.${mode}`, `egress.payload.${payload}`],
  }
}

function optionValue(
  token: string,
  next: string,
  flags: readonly string[],
): { value: string; fromNext: boolean } | null {
  if (flags.includes(token)) {
    return next ? { value: next, fromNext: true } : null
  }
  for (const flag of flags) {
    if (token.startsWith(`${flag}=`)) {
      return { value: token.slice(flag.length + 1), fromNext: false }
    }
    if (flag.length === 2 && token.startsWith(flag) && token.length > 2) {
      return { value: token.slice(flag.length), fromNext: false }
    }
  }
  return null
}

function matchesAnyOption(token: string, flags: readonly string[]): boolean {
  return flags.some(
    (flag) =>
      token === flag ||
      token.startsWith(`${flag}=`) ||
      (flag.length === 2 && token.startsWith(flag) && token.length > 2),
  )
}

function mergePayload(
  current: EgressGrammar['payload'],
  next: EgressGrammar['payload'],
): EgressGrammar['payload'] {
  if (current === 'secret' || next === 'secret') {
    return 'secret'
  }
  return current === 'present' || next === 'present' ? 'present' : 'none'
}

function mergeTransferModes(transfers: EgressGrammar['transfers']): EgressGrammar['mode'] {
  const modes = new Set(transfers.map((transfer) => transfer.mode))
  if (modes.size === 1) {
    return transfers[0]?.mode ?? 'ambiguous'
  }
  return 'ambiguous'
}

function uploadFileOperand(value: { value: string }): string | null {
  const formFile = /(?:^|=)[@<](.+)$/.exec(value.value)
  if (formFile?.[1]) {
    return formFile[1]
  }
  return value.value.startsWith('@') || value.value.startsWith('<') ? value.value.slice(1) : null
}

function isSecretValue(value: string | { value: string }): boolean {
  const raw = typeof value === 'string' ? value : value.value
  return SECRET_VALUE_PATTERN.test(raw.replace(/^@/, ''))
}

function isExplicitSecretInterpolation(token: string): boolean {
  return (
    (/\b(?:authorization|token|secret|password|credential)\b/i.test(token) &&
      /\$(?:\{|[A-Za-z_])/.test(token)) ||
    /\bBearer\s+\$/i.test(token) ||
    (token.includes('$') && isSecretValue(token))
  )
}

function expandHome(value: string): string {
  if (value === '~') {
    return process.env.HOME ?? value
  }
  if (value.startsWith('~/')) {
    return path.join(process.env.HOME ?? '~', value.slice(2))
  }
  return value
}

function requirement(
  tag: ShellEffectRequirement['tag'],
  action: ShellEffectRequirement['action'],
  resource: ShellEffectRequirement['resource'],
  segment: string,
  signals: string[],
): ShellEffectRequirement {
  return {
    tag,
    action,
    resource,
    evidence: {
      level: tag === 'indeterminate' ? 'indeterminate' : 'certain',
      signals: [...new Set(signals)].sort(),
      basis: ['egress_grammar'],
    },
    provenance: { segment },
  }
}

function classifyCurlWget(tokens: string[]): EgressClassification {
  const args = tokens.slice(1)
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token) {
      continue
    }
    if (CURL_DATA_FLAGS.has(token)) {
      return 'destructive'
    }
    if (CURL_DATA_PREFIXES.some((prefix) => token.startsWith(prefix))) {
      return 'destructive'
    }
    if (token.startsWith('--method=')) {
      const method = token.slice('--method='.length).toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        return 'destructive'
      }
    }
    if (token === '-X' || token === '--request') {
      const method = (args[index + 1] ?? '').toUpperCase()
      if (method && method !== 'GET' && method !== 'HEAD') {
        return 'destructive'
      }
    }
    if (token.startsWith('@')) {
      return 'destructive'
    }
    if (token.includes('@') && /(^|[^\\])@/.test(token)) {
      return 'destructive'
    }
  }
  return 'read'
}

function classifyAws(tokens: string[]): EgressClassification {
  const rest = tokens.slice(1)
  const joined = rest.join(' ').toLowerCase()

  if (/\bs3\s+rm\b/.test(joined)) {
    return 'destructive'
  }
  if (/\bs3\s+mb\b/.test(joined)) {
    return 'destructive'
  }
  if (/\bs3\s+sync\b/.test(joined)) {
    return 'destructive'
  }
  if (/\bs3\s+cp\b/.test(joined)) {
    const s3Args = rest.filter((token) => token.startsWith('s3://'))
    if (s3Args.length >= 2) {
      return 'ambiguous'
    }
    const lastToken = rest[rest.length - 1] ?? ''
    if (lastToken.startsWith('s3://')) {
      return 'destructive'
    }
    if (s3Args.length === 1 && !lastToken.startsWith('s3://')) {
      return 'read'
    }
    return 'ambiguous'
  }
  if (/\b(delete|terminate)\b/.test(joined)) {
    return 'destructive'
  }
  if (/\b(put|create|update)\b/.test(joined)) {
    return 'destructive'
  }
  if (READ_VERB_PATTERN.test(joined)) {
    return 'read'
  }
  return 'ambiguous'
}

function classifyGh(tokens: string[]): EgressClassification {
  const joined = tokens.slice(1).join(' ').toLowerCase()

  if (/\brelease\s+create\b/.test(joined)) {
    return 'destructive'
  }
  if (/\brepo\s+(delete|create)\b/.test(joined)) {
    return 'destructive'
  }
  if (/\bpr\s+merge\b/.test(joined)) {
    return 'destructive'
  }
  if (/\bsecret\s+set\b/.test(joined)) {
    return 'destructive'
  }
  if (/\bworkflow\s+run\b/.test(joined)) {
    return 'destructive'
  }
  if (/\bapi\b/.test(joined) && /\s(-x|--method)\s+(post|put|patch|delete)\b/.test(joined)) {
    return 'destructive'
  }
  if (/\bpr\s+list\b/.test(joined)) {
    return 'read'
  }
  if (READ_VERB_PATTERN.test(joined)) {
    return 'read'
  }
  return 'ambiguous'
}

function classifyGcloud(tokens: string[]): EgressClassification {
  const joined = tokens.slice(1).join(' ').toLowerCase()

  if (/\b(delete|create|update|deploy)\b/.test(joined)) {
    return 'destructive'
  }
  if (/\bset-/.test(joined)) {
    return 'destructive'
  }
  if (READ_VERB_PATTERN.test(joined)) {
    return 'read'
  }
  return 'ambiguous'
}

function classifyKubectl(tokens: string[]): EgressClassification {
  const sub = (tokens[1] ?? '').toLowerCase()
  if (KUBECTL_DESTRUCTIVE.has(sub)) {
    return 'destructive'
  }
  if (KUBECTL_READ.has(sub)) {
    return 'read'
  }
  return 'ambiguous'
}

function classifyHeroku(tokens: string[]): EgressClassification {
  const joined = tokens.slice(1).join(' ').toLowerCase()

  if (
    /\bdeploy\b/.test(joined) ||
    /pg:reset/.test(joined) ||
    /ps:scale/.test(joined) ||
    /\bdestroy\b/.test(joined)
  ) {
    return 'destructive'
  }
  if (READ_VERB_PATTERN.test(joined)) {
    return 'read'
  }
  return 'ambiguous'
}

function classifyVercel(tokens: string[]): EgressClassification {
  const joined = tokens.slice(1).join(' ').toLowerCase()

  if (/\bdeploy\b/.test(joined) || /--prod\b/.test(joined) || /\bdestroy\b/.test(joined)) {
    return 'destructive'
  }
  if (READ_VERB_PATTERN.test(joined)) {
    return 'read'
  }
  return 'ambiguous'
}

function classifyNetlify(tokens: string[]): EgressClassification {
  const joined = tokens.slice(1).join(' ').toLowerCase()

  if (/\bdeploy\b/.test(joined) || /--prod\b/.test(joined)) {
    return 'destructive'
  }
  if (READ_VERB_PATTERN.test(joined)) {
    return 'read'
  }
  return 'ambiguous'
}
