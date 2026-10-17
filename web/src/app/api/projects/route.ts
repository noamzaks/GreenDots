import type { NextRequest } from "next/server"
import { eventStream, watch } from "@/lib/api"
import { store } from "@/lib/store"

/** Every project in every source, streamed as it changes. */
export function GET(request: NextRequest) {
  return eventStream(request, async (send, signal) => {
    const unview = store().view("")
    try {
      await watch(signal, send, () => store().projects())
    } finally {
      unview()
    }
  })
}
