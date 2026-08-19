import { describe, expect, it } from 'vitest'

import {
  createStreamingScrubber,
  STREAMING_SCRUBBER_MAX_BUFFER_BYTES,
  scrubString,
} from '../core/scrub.js'

function configuredStreamingScrubber() {
  return createStreamingScrubber({
    maskApprovalIds: true,
    maskBearerTokens: true,
    maskAuthHeaders: true,
    maskKeyValueSecrets: true,
    maskHighEntropyStrings: true,
  })
}

function chunkSizes(kind: 'whole' | 'bytewise' | 'varied', byteLength: number): number[] {
  if (kind === 'whole') return [byteLength]
  if (kind === 'bytewise') return Array.from({ length: byteLength }, () => 1)
  const pattern = [1, 7, 2, 31, 3, 5, 64, 11, 127, 4, 19]
  const sizes: number[] = []
  let consumed = 0
  let index = 0
  while (consumed < byteLength) {
    const size = Math.min(pattern[index % pattern.length] ?? 1, byteLength - consumed)
    sizes.push(size)
    consumed += size
    index += 1
  }
  return sizes
}

function streamScrub(
  input: string,
  chunking: 'whole' | 'bytewise' | 'varied',
): { output: string; maxBufferedBytes: number } {
  const scrubber = configuredStreamingScrubber()
  const bytes = Buffer.from(input)
  let offset = 0
  let output = ''
  let maxBufferedBytes = 0
  for (const size of chunkSizes(chunking, bytes.length)) {
    output += scrubber.write(bytes.subarray(offset, offset + size))
    offset += size
    maxBufferedBytes = Math.max(maxBufferedBytes, scrubber.bufferedBytes)
  }
  output += scrubber.end()
  maxBufferedBytes = Math.max(maxBufferedBytes, scrubber.bufferedBytes)
  return { output, maxBufferedBytes }
}

describe('scrubString', () => {
  it('masks bearer tokens when enabled', () => {
    const input = 'curl -H "Authorization: Bearer abc.def.ghi" https://example.com'
    expect(scrubString(input)).toContain('Authorization: <redacted>')
    expect(scrubString(input)).not.toContain('abc.def.ghi')
  })

  it('masks key=value secrets when enabled', () => {
    const input = 'export API_KEY=supersecretvalue'
    expect(scrubString(input)).toBe('export API_KEY=<redacted>')
  })

  it('respects disabled redaction toggles', () => {
    const input = 'token=abc123'
    expect(scrubString(input, { maskKeyValueSecrets: false })).toBe(input)
  })

  it('masks high-entropy strings only when enabled', () => {
    const input = 'value=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'
    expect(scrubString(input, { maskHighEntropyStrings: false })).toContain('ABCDEFGHIJ')
    expect(scrubString(input, { maskHighEntropyStrings: true })).toContain('<high-entropy>')
  })

  it('masks URL credentials and inline mysql passwords', () => {
    const input = 'mysql -phunter2 postgres://user:pass@host/db'
    const scrubbed = scrubString(input)
    expect(scrubbed).not.toContain('hunter2')
    expect(scrubbed).not.toContain('user:pass@')
    expect(scrubbed).toContain('-p<redacted>')
    expect(scrubbed).toContain('postgres://<redacted>:<redacted>@host/db')
  })

  it('masks generic auth headers', () => {
    const input = 'Authorization: Token abc123 X-Api-Key: secret-token'
    const scrubbed = scrubString(input)
    expect(scrubbed).toContain('Authorization: <redacted>')
    expect(scrubbed).toContain('X-Api-Key: <redacted>')
  })
})

describe('streaming scrubber', () => {
  const whitespace = ' '.repeat(40_000)
  const longUsername = 'user.part.'.repeat(3_000)
  const cases = [
    {
      name: 'authorization header',
      input: `SAFE Authorization:${whitespace}AUTH.LEAK.VALUE. END 終端`,
      forbidden: ['AUTH.LEAK.VALUE.'],
    },
    {
      name: 'authorization scheme with whitespace before its value',
      input: `SAFE Authorization:${whitespace}Basic${whitespace}BASIC.AUTH.LEAK. END 終端`,
      forbidden: ['BASIC.AUTH.LEAK.'],
    },
    {
      name: 'double-quoted authorization header',
      input: `SAFE "Authorization:${whitespace}QUOTED.AUTH.LEAK." END 終端`,
      forbidden: ['QUOTED.AUTH.LEAK.'],
    },
    {
      name: 'single-quoted authorization header',
      input: `SAFE 'Authorization:${whitespace}SINGLE.AUTH.LEAK.' END 終端`,
      forbidden: ['SINGLE.AUTH.LEAK.'],
    },
    {
      name: 'bearer token',
      input: `SAFE Bearer${whitespace}BEAR.LEAK.VALUE. END 終端`,
      forbidden: ['BEAR.LEAK.VALUE.'],
    },
    {
      name: 'generic auth header',
      input: `SAFE X-Api-Key:${whitespace}HEADER.LEAK.VALUE. END 終端`,
      forbidden: ['HEADER.LEAK.VALUE.'],
    },
    {
      name: 'alternate generic auth header',
      input: `SAFE X-Auth-Token:${whitespace}ALTERNATE.HEADER.LEAK. END 終端`,
      forbidden: ['ALTERNATE.HEADER.LEAK.'],
    },
    {
      name: 'quoted generic auth header',
      input: `SAFE "Private-Token:${whitespace}QUOTED.HEADER.LEAK." END 終端`,
      forbidden: ['QUOTED.HEADER.LEAK.'],
    },
    ...['api_key', 'token', 'secret', 'password', 'passwd', 'credential'].map((name) => ({
      name: `${name} key/value`,
      input: `SAFE ${name}${whitespace}=${whitespace}${name}.LEAK.VALUE. END 終端`,
      forbidden: [`${name}.LEAK.VALUE.`],
    })),
    {
      name: 'quoted key/value secret',
      input: `SAFE credential${whitespace}=${whitespace}'QUOTED.KEY.LEAK.' END 終端`,
      forbidden: ['QUOTED.KEY.LEAK.'],
    },
    {
      name: 'URL credentials with a long username',
      input: `SAFE https://${longUsername}:PASS.LEAK.VALUE.@host/path END 終端`,
      forbidden: ['user.part.', 'PASS.LEAK.VALUE.'],
    },
    {
      name: 'mysql inline password',
      input: 'SAFE mysql -pMYSQL.LEAK.VALUE. database END 終端',
      forbidden: ['MYSQL.LEAK.VALUE.'],
    },
    {
      name: 'approval command',
      input: `SAFE /belay-approve${whitespace}APPROVAL.LEAK.VALUE. END 終端`,
      forbidden: ['APPROVAL.LEAK.VALUE.'],
    },
    {
      name: 'approval id',
      input: `SAFE belay_approvalleakvalue123456789 END 終端`,
      forbidden: ['belay_approvalleakvalue123456789'],
    },
    {
      name: 'high entropy value',
      input: `SAFE ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'.repeat(2)} END 終端`,
      forbidden: ['ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'],
    },
    {
      name: 'high entropy value beginning with a key-name marker',
      input: `SAFE token${'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'.repeat(2)} END 終端`,
      forbidden: ['tokenABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    },
    {
      name: 'UUID',
      input: 'SAFE 123e4567-e89b-42d3-a456-426614174000 END 終端',
      forbidden: ['123e4567-e89b-42d3-a456-426614174000'],
    },
    {
      name: 'timestamp',
      input: 'SAFE 2026-08-18T12:34:56.789Z END 終端',
      forbidden: ['2026-08-18T12:34:56.789Z'],
    },
  ]

  it.each(cases)('redacts $name across whole, bytewise, and varied chunks', ({
    input,
    forbidden,
  }) => {
    const completeStringResult = scrubString(input, {
      maskApprovalIds: true,
      maskBearerTokens: true,
      maskAuthHeaders: true,
      maskKeyValueSecrets: true,
      maskHighEntropyStrings: true,
    })
    for (const chunking of ['whole', 'bytewise', 'varied'] as const) {
      const result = streamScrub(input, chunking)
      expect(result.output).toContain('SAFE')
      expect(result.output).toContain('END 終端')
      expect(result.output).not.toContain('\uFFFD')
      for (const secret of forbidden) {
        expect(completeStringResult).not.toContain(secret)
        expect(result.output).not.toContain(secret)
      }
      expect(result.maxBufferedBytes).toBeLessThanOrEqual(STREAMING_SCRUBBER_MAX_BUFFER_BYTES)
    }
  })

  const quoteSensitiveCases = [
    ...['"', "'"].flatMap((quote) => [
      {
        name: `unquoted authorization with ${quote}`,
        input: `SAFE Authorization: abc${quote}AUTH.QUOTE.LEAK END 終端`,
        sentinel: 'AUTH.QUOTE.LEAK',
      },
      {
        name: `unquoted generic header with ${quote}`,
        input: `SAFE X-Api-Key: abc${quote}HEADER.QUOTE.LEAK END 終端`,
        sentinel: 'HEADER.QUOTE.LEAK',
      },
      {
        name: `approval command with ${quote}`,
        input: `SAFE /belay-approve abc${quote}APPROVAL.QUOTE.LEAK END 終端`,
        sentinel: 'APPROVAL.QUOTE.LEAK',
      },
      {
        name: `mysql password with ${quote}`,
        input: `SAFE mysql -pabc${quote}MYSQL.QUOTE.LEAK END 終端`,
        sentinel: 'MYSQL.QUOTE.LEAK',
      },
    ]),
  ]

  it.each(quoteSensitiveCases)('does not end the batch non-whitespace grammar early for $name', ({
    input,
    sentinel,
  }) => {
    expect(scrubString(input)).not.toContain(sentinel)
    for (const chunking of ['whole', 'bytewise', 'varied'] as const) {
      expect(streamScrub(input, chunking).output).not.toContain(sentinel)
    }
  })

  const punctuation = ['.', ':', '@', '/', '=', '+', '_', '-', '?', '#']
  const asciiPunctuation = Array.from(`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`)
  const urlPunctuationCases = [
    ...asciiPunctuation
      .filter((mark) => !['/', ':', '@'].includes(mark))
      .map((mark) => ({
        name: `URL username punctuation ${mark}`,
        input: `SAFE https://pre${mark}USER.URL.SENTINEL:pass@host/path END 終端`,
        eofInput: `SAFE https://pre${mark}USER.URL.SENTINEL:pass@host`,
        sentinel: 'USER.URL.SENTINEL',
      })),
    ...asciiPunctuation
      .filter((mark) => !['/', '@'].includes(mark))
      .map((mark) => ({
        name: `URL password punctuation ${mark}`,
        input: `SAFE https://user:pre${mark}PASSWORD.URL.SENTINEL@host/path END 終端`,
        eofInput: `SAFE https://user:pre${mark}PASSWORD.URL.SENTINEL@host`,
        sentinel: 'PASSWORD.URL.SENTINEL',
      })),
  ]

  it.each(
    urlPunctuationCases,
  )('keeps $name inside the conservative authority state through path and EOF', ({
    input,
    eofInput,
    sentinel,
  }) => {
    for (const value of [input, eofInput]) {
      expect(scrubString(value)).not.toContain(sentinel)
      for (const chunking of ['whole', 'bytewise', 'varied'] as const) {
        expect(streamScrub(value, chunking).output).not.toContain(sentinel)
      }
    }
  })

  it('reprocesses a URL path slash so an adjacent approval marker is scrubbed', () => {
    const input = 'SAFE https://user:pass@host/belay-approve ADJACENT.APPROVAL.SENTINEL END 終端'
    const sentinel = 'ADJACENT.APPROVAL.SENTINEL'
    expect(scrubString(input)).not.toContain(sentinel)
    for (const chunking of ['whole', 'bytewise', 'varied'] as const) {
      expect(streamScrub(input, chunking).output).not.toContain(sentinel)
    }
  })

  const differentialCases = [
    ...punctuation.flatMap((mark) => [
      {
        name: `authorization punctuation ${mark}`,
        input: `SAFE Authorization: pre${mark}AUTH.SENTINEL${mark}post END 終端`,
        sentinel: 'AUTH.SENTINEL',
      },
      {
        name: `generic-header punctuation ${mark}`,
        input: `SAFE Private-Token: pre${mark}HEADER.SENTINEL${mark}post END 終端`,
        sentinel: 'HEADER.SENTINEL',
      },
      {
        name: `approval-command punctuation ${mark}`,
        input: `SAFE /belay-approve pre${mark}APPROVAL.SENTINEL${mark}post END 終端`,
        sentinel: 'APPROVAL.SENTINEL',
      },
      {
        name: `mysql punctuation ${mark}`,
        input: `SAFE mysql -ppre${mark}MYSQL.SENTINEL${mark}post END 終端`,
        sentinel: 'MYSQL.SENTINEL',
      },
      {
        name: `key/value punctuation ${mark}`,
        input: `SAFE credential=pre${mark}KEY.SENTINEL${mark}post END 終端`,
        sentinel: 'KEY.SENTINEL',
      },
    ]),
    {
      name: 'double-quoted authorization grammar',
      input: 'SAFE "Authorization: pre.AUTH.SENTINEL/post" END 終端',
      sentinel: 'AUTH.SENTINEL',
    },
    {
      name: 'single-quoted generic-header grammar',
      input: "SAFE 'X-Auth-Token: pre.HEADER.SENTINEL/post' END 終端",
      sentinel: 'HEADER.SENTINEL',
    },
    {
      name: 'double-quoted key/value grammar',
      input: 'SAFE api_key="pre.KEY.SENTINEL/post" END 終端',
      sentinel: 'KEY.SENTINEL',
    },
    {
      name: 'single-quoted key/value grammar',
      input: "SAFE token='pre.KEY.SENTINEL/post' END 終端",
      sentinel: 'KEY.SENTINEL',
    },
    {
      name: 'Bearer alphabet grammar',
      input: 'SAFE Bearer abc.BEARERSENTINEL123_~+/=- END 終端',
      sentinel: 'BEARERSENTINEL123',
    },
    {
      name: 'approval ID alphabet grammar',
      input: 'SAFE belay_abcdefghapprovalsentinel123 END 終端',
      sentinel: 'approvalsentinel123',
    },
    {
      name: 'URL credential grammar',
      input: 'SAFE https://user.part:URL.SENTINEL@host/path END 終端',
      sentinel: 'URL.SENTINEL',
    },
    {
      name: 'high-entropy grammar and key-marker overlap',
      input: `SAFE token${'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'.repeat(2)} END 終端`,
      sentinel: 'tokenABCDEFGHIJKLMNOPQRSTUVWXYZ',
    },
    {
      name: 'UUID grammar',
      input: 'SAFE 123e4567-e89b-42d3-a456-426614174000 END 終端',
      sentinel: '123e4567-e89b-42d3-a456-426614174000',
    },
    {
      name: 'timestamp grammar',
      input: 'SAFE 2026-08-18T12:34:56.789Z END 終端',
      sentinel: '2026-08-18T12:34:56.789Z',
    },
    {
      name: 'authorization long-gap grammar',
      input: `SAFE Authorization:${' '.repeat(40_000)}AUTH.LONG.GAP.SENTINEL END 終端`,
      sentinel: 'AUTH.LONG.GAP.SENTINEL',
    },
    {
      name: 'URL long-authority grammar',
      input: `SAFE https://${'user.part.'.repeat(3_000)}:URL.LONG.SENTINEL@host/path END 終端`,
      sentinel: 'URL.LONG.SENTINEL',
    },
    ...[
      ['authorization at end-of-stream', 'SAFE Authorization: eof.AUTH.SENTINEL', 'AUTH.SENTINEL'],
      ['generic header at end-of-stream', 'SAFE X-Api-Key: eof.HEADER.SENTINEL', 'HEADER.SENTINEL'],
      [
        'approval command at end-of-stream',
        'SAFE /belay-approve eof.APPROVAL.SENTINEL',
        'APPROVAL.SENTINEL',
      ],
      ['mysql password at end-of-stream', 'SAFE mysql -peof.MYSQL.SENTINEL', 'MYSQL.SENTINEL'],
      ['key/value at end-of-stream', 'SAFE token=eof.KEY.SENTINEL', 'KEY.SENTINEL'],
      ['Bearer at end-of-stream', 'SAFE Bearer eof.BEARERSENTINEL123', 'BEARERSENTINEL123'],
      [
        'approval ID at end-of-stream',
        'SAFE belay_abcdefghapprovalsentinel123',
        'approvalsentinel123',
      ],
      ['URL credentials at end-of-stream', 'SAFE https://user:URL.SENTINEL@host', 'URL.SENTINEL'],
      [
        'quoted authorization at end-of-stream',
        'SAFE "Authorization: eof.AUTH.SENTINEL"',
        'AUTH.SENTINEL',
      ],
      [
        'quoted generic header at end-of-stream',
        "SAFE 'Private-Token: eof.HEADER.SENTINEL'",
        'HEADER.SENTINEL',
      ],
      ['quoted key/value at end-of-stream', 'SAFE password="eof.KEY.SENTINEL"', 'KEY.SENTINEL'],
      ['high entropy at end-of-stream', `SAFE ${'A'.repeat(48)}`, 'A'.repeat(48)],
      [
        'UUID at end-of-stream',
        'SAFE 123e4567-e89b-42d3-a456-426614174000',
        '123e4567-e89b-42d3-a456-426614174000',
      ],
      ['timestamp at end-of-stream', 'SAFE 2026-08-18T12:34:56.789Z', '2026-08-18T12:34:56.789Z'],
    ].map(([name, input, sentinel]) => ({ name, input, sentinel })),
  ]

  it.each(differentialCases)('never exposes $name sentinels removed by the batch scrubber', ({
    input,
    sentinel,
  }) => {
    expect(
      scrubString(input, {
        maskApprovalIds: true,
        maskBearerTokens: true,
        maskAuthHeaders: true,
        maskKeyValueSecrets: true,
        maskHighEntropyStrings: true,
      }),
    ).not.toContain(sentinel)
    for (const chunking of ['whole', 'bytewise', 'varied'] as const) {
      const streamed = streamScrub(input, chunking)
      expect(streamed.output).not.toContain(sentinel)
      expect(streamed.maxBufferedBytes).toBeLessThanOrEqual(STREAMING_SCRUBBER_MAX_BUFFER_BYTES)
    }
  })
})
