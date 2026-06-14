/**
 * Tier0 egress tool classification (SPEC v2.1.3 R33–R34).
 * destructive → Tier0 ask | read → Tier0 allow | ambiguous → Tier1 (fail-closed)
 */

export type EgressClassification = 'destructive' | 'read' | 'ambiguous'

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
