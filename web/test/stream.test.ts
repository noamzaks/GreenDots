import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { follow } from "../src/lib/client"

/** An EventSource the test drives: `fail()` gives up on it, as Firefox does when the network changes. */
class FakeEventSource {
  static CLOSED = 2
  static opened: FakeEventSource[] = []
  readyState = 1
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  constructor(readonly url: string) {
    FakeEventSource.opened.push(this)
  }
  close() {
    this.readyState = 2
  }
  fail() {
    this.readyState = 2
    this.onerror?.()
  }
  send(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

beforeEach(() => {
  FakeEventSource.opened = []
  vi.useFakeTimers()
  vi.stubGlobal("EventSource", FakeEventSource)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test("reopens a stream the browser gave up on, backing off while it keeps failing", () => {
  const messages: unknown[] = []
  const errors: unknown[] = []
  follow(
    "/api/run",
    (data) => messages.push(data),
    (error) => errors.push(error),
  )
  FakeEventSource.opened[0].send({ version: 1 })
  FakeEventSource.opened[0].fail()
  expect(errors.at(-1)).toBe("Disconnected, reconnecting…")
  vi.advanceTimersByTime(1000)
  expect(FakeEventSource.opened).toHaveLength(2)
  FakeEventSource.opened[1].fail()
  vi.advanceTimersByTime(1000)
  expect(FakeEventSource.opened).toHaveLength(2) // waits longer after failing again
  vi.advanceTimersByTime(1000)
  expect(FakeEventSource.opened).toHaveLength(3)
  FakeEventSource.opened[2].send({ version: 2 })
  expect(messages).toEqual([{ version: 1 }, { version: 2 }])
  expect(errors.at(-1)).toBeUndefined()
})

test("doesn't reopen a stream that is still reconnecting by itself, or that was closed", () => {
  const close = follow("/api/run", () => {})
  const source = FakeEventSource.opened[0]
  source.readyState = 0 // the browser retries this one
  source.onerror?.()
  vi.advanceTimersByTime(60_000)
  expect(FakeEventSource.opened).toHaveLength(1)
  source.fail()
  close()
  vi.advanceTimersByTime(60_000)
  expect(FakeEventSource.opened).toHaveLength(1)
})
