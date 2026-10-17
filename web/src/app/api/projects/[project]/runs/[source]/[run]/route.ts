import type { NextRequest } from "next/server"
import { eventStream } from "@/lib/api"
import { store } from "@/lib/store"
import type { RunUpdate } from "@/lib/types"

type Params = RouteContext<"/api/projects/[project]/runs/[source]/[run]">

/** A run: everything first, then the tests that changed (and the plan, if it changed), as they change. */
export async function GET(request: NextRequest, ctx: Params) {
  const { project, source, run: name } = await ctx.params
  const run = store().run(project, source, name)
  if (!run) return Response.json({ error: "no such run" }, { status: 404 })
  return eventStream(request, async (send, signal) => {
    run.viewers++
    try {
      let sent: { version: number; planVersion: number; rest: string } | undefined
      while (!signal.aborted) {
        run.lastAccess = Date.now()
        if (!run.plan) send({ waiting: true })
        else {
          const { version, planVersion, title, plan } = run
          const summary = run.summary()
          const polling = store().polling(run)
          const rest = JSON.stringify([title, summary, polling])
          if (!sent || version !== sent.version || planVersion !== sent.planVersion || rest !== sent.rest) {
            const update: RunUpdate = {
              full: !sent,
              version,
              planVersion,
              title,
              plan: planVersion !== sent?.planVersion ? plan : undefined,
              summary,
              polling,
              tests: run.changes(sent?.version ?? -1),
            }
            send(update)
            sent = { version, planVersion, rest }
          }
        }
        await store().changed.wait(25_000, signal)
      }
    } finally {
      run.viewers--
    }
  })
}
