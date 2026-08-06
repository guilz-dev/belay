import { canonicalStringify, hashValue } from '../fingerprint.js'
import type { CapabilityRequestV1 } from './request.js'

export function hashCapabilityRequests(requests: CapabilityRequestV1[]): string {
  if (requests.length === 0) {
    return ''
  }
  const normalized = [...requests].sort((left, right) =>
    canonicalStringify(left).localeCompare(canonicalStringify(right)),
  )
  return hashValue(`capability-requests:v1:${canonicalStringify(normalized)}`)
}
