/** Wakes up everyone waiting for something to change (e.g. long-polling requests). */
export class Signal {
  private waiters = new Set<() => void>()

  notify() {
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }

  /** Resolves on the next `notify`, after `ms`, or when `abort` fires, whichever comes first. */
  wait(ms: number, abort?: AbortSignal) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        abort?.removeEventListener("abort", done)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      abort?.addEventListener("abort", done)
      this.waiters.add(done)
    })
  }
}
