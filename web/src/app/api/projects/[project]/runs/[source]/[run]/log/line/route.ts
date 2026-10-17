import { api, findLog, number } from "@/lib/api"
import { store } from "@/lib/store"

/** A piece of the (long) line at `offset`, from byte `from` on; or, with `download`, the whole line. */
export const GET = api(async (request, ctx: RouteContext<"/api/projects/[project]/runs/[source]/[run]/log/line">) => {
  const log = await findLog(request, ctx.params)
  const offset = number(request, "offset")
  if (!log || offset === undefined) return Response.json({ error: "no such line" }, { status: 404 })
  const s = store()
  const size = await s.logSize(log.path)
  if (!request.nextUrl.searchParams.has("download"))
    return Response.json(await s.logs.message(log.path, offset, size, number(request, "from")))
  let from: number | undefined
  const stream = new ReadableStream({
    async pull(controller) {
      const chunk = await s.logs.message(log.path, offset, size, from)
      controller.enqueue(new TextEncoder().encode(chunk.text))
      from = chunk.next
      if (chunk.done) controller.close()
    },
  })
  const headers = {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": 'attachment; filename="line.txt"',
  }
  return new Response(stream, { headers })
})
