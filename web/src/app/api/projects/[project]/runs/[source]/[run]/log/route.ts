import type { NextRequest } from "next/server"
import { eventStream, findLog } from "@/lib/api"
import { store } from "@/lib/store"
import type { LogUpdate } from "@/lib/types"

const isOver = (status?: string) => status !== undefined && status !== "running" && status !== "pending"

/**
 * A log: its end first, then lines as they're written. The log is stat-ed at most once per poll interval
 * however many clients follow it, and not anymore once its test (or run) is over and it stopped growing.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/projects/[project]/runs/[source]/[run]/log">) {
  const log = await findLog(request, ctx.params)
  if (!log) return Response.json({ error: "no such log" }, { status: 404 })
  const { run, path, state } = log
  const s = store()
  return eventStream(request, async (send, signal) => {
    run.viewers++
    try {
      // once its test (or run) is over, nothing more is written: a last line without a newline is complete
      const final = () => (state() ? isOver(state()?.status) : run.done)
      let size = await s.logSize(path)
      const tail = await s.logs.before(path, size)
      const last = final() && tail.end < size ? await s.logs.forward(path, tail.end, size, true) : undefined
      let end = last?.end ?? tail.end
      send({
        ...tail,
        lines: [...tail.lines, ...(last?.lines ?? [])],
        end,
        size,
        test: state(),
        full: true,
      } satisfies LogUpdate)
      let quiet = 0 // checks without growth since the test (or run) was over
      let sent = JSON.stringify(state())
      while (!signal.aborted) {
        const over = final()
        const following = quiet < 3 && s.polling(run) !== "stopped"
        await s.changed.wait(following ? s.config.polling.run * 1000 : 25_000, signal)
        if (signal.aborted) break
        run.lastAccess = Date.now()
        if (following) {
          size = await s.logSize(path)
          quiet = size > end || !over ? 0 : quiet + 1
        }
        const test = JSON.stringify(state())
        if (size <= end && test === sent) continue
        const chunk = size > end ? await s.logs.forward(path, end, size, over) : { lines: [], end }
        send({ ...chunk, start: end, size, test: state(), full: false } satisfies LogUpdate)
        end = chunk.end
        sent = test
      }
    } finally {
      run.viewers--
    }
  })
}
