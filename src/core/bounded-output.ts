export const OUTPUT_TAIL_LIMIT_BYTES = 16_384

export interface BoundedOutputTail {
  tail: Buffer
  truncated: boolean
}

export function appendBoundedOutputTail(
  current: Buffer,
  chunk: Buffer | string,
  limitBytes = OUTPUT_TAIL_LIMIT_BYTES,
): BoundedOutputTail {
  const next = Buffer.concat([current, Buffer.from(chunk)])
  return {
    tail: next.length > limitBytes ? next.subarray(-limitBytes) : next,
    truncated: next.length > limitBytes,
  }
}

export function decodeBoundedOutputTail(tail: Buffer): string {
  for (let offset = 0; offset <= Math.min(3, tail.length); offset += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(tail.subarray(offset))
    } catch {
      // A byte cap may have cut a leading multi-byte character; try its next boundary.
    }
  }
  return tail.toString('utf8')
}

export function boundedUtf8Tail(
  value: string,
  limitBytes = OUTPUT_TAIL_LIMIT_BYTES,
): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value)
  if (encoded.length <= limitBytes) return { value, truncated: false }
  const tail = encoded.subarray(-limitBytes)
  return { value: decodeBoundedOutputTail(tail), truncated: true }
}
