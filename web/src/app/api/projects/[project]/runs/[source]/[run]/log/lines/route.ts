import { api, findLog, number } from "@/lib/api"
import { store } from "@/lib/store"
import type { LogChunk } from "@/lib/types"

/** Lines of a log ending at `before` (default: the end), about `bytes` of them (at most a window). */
export const GET = api(async (request, ctx: RouteContext<"/api/projects/[project]/runs/[source]/[run]/log/lines">) => {
  const log = await findLog(request, ctx.params)
  if (!log) return Response.json({ error: "no such log" }, { status: 404 })
  const size = await store().logSize(log.path)
  const chunk = await store().logs.before(log.path, number(request, "before") ?? size, number(request, "bytes"))
  return Response.json({ ...chunk, size, test: log.state() } satisfies LogChunk)
})
