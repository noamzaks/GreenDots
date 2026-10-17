import type { NextRequest } from "next/server"
import { eventStream } from "@/lib/api"
import { store } from "@/lib/store"

/** The latest filesystem operations, syncs and requests, streamed in batches. Not recorded itself. */
export function GET(request: NextRequest) {
  const { activity } = store()
  return eventStream(request, async (send, signal) => {
    let seq = 0
    while (!signal.aborted) {
      const entries = activity.since(seq)
      if (entries.length) send({ capacity: activity.capacity, entries })
      seq = activity.seq
      await activity.changed.wait(25_000, signal)
      await new Promise((resolve) => setTimeout(resolve, 250)) // batch bursts
    }
  })
}
