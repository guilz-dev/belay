export class AsyncMutex {
  private chain: Promise<void> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

export class MutexRegistry {
  private readonly mutexes = new Map<string, AsyncMutex>()

  forKey(key: string): AsyncMutex {
    const existing = this.mutexes.get(key)
    if (existing) {
      return existing
    }
    const created = new AsyncMutex()
    this.mutexes.set(key, created)
    return created
  }

  clear(): void {
    this.mutexes.clear()
  }
}
