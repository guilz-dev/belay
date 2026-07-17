import type readline from 'node:readline'

export function mockInteractiveTTY(value: boolean): () => void {
  const previousStdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const previousStdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value })
  return () => {
    if (previousStdin) {
      Object.defineProperty(process.stdin, 'isTTY', previousStdin)
    } else {
      Reflect.deleteProperty(process.stdin, 'isTTY')
    }
    if (previousStdout) {
      Object.defineProperty(process.stdout, 'isTTY', previousStdout)
    } else {
      Reflect.deleteProperty(process.stdout, 'isTTY')
    }
  }
}

export function mockSetRawMode(fn?: (mode: boolean) => void): {
  calls: boolean[]
  restore: () => void
} {
  const previous = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode')
  const calls: boolean[] = []
  const handler = (mode: boolean) => {
    calls.push(mode)
    fn?.(mode)
  }
  Object.defineProperty(process.stdin, 'setRawMode', {
    configurable: true,
    value: handler,
  })
  return {
    calls,
    restore: () => {
      if (previous) {
        Object.defineProperty(process.stdin, 'setRawMode', previous)
      } else {
        Reflect.deleteProperty(process.stdin, 'setRawMode')
      }
    },
  }
}

export async function emitKeypress(name: string, ctrl = false): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      process.stdin.emit('keypress', '', { name, ctrl } as readline.Key)
      resolve()
    })
  })
}
