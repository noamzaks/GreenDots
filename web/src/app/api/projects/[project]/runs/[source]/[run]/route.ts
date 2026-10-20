import type { NextRequest } from "next/server"
import { eventStream, Serialized } from "@/lib/api"
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
        if (!run.plan) await run.syncing?.catch(() => {}) // its first read, to tell loading from not started
        if (!run.plan) send({ waiting: true })
        else {
          const { version, planVersion, title, plan } = run
          const summary = run.summary()
          const polling = store().polling(run)
          const rest = JSON.stringify([title, summary, polling])
          if (!sent || version !== sent.version || planVersion !== sent.planVersion || rest !== sent.rest) {
            const update = (): RunUpdate => ({
              full: !sent,
              version,
              planVersion,
              title,
              // without the tests' log files, which browsers don't need
              plan:
                planVersion !== sent?.planVersion
                  ? { ...plan, tests: plan.tests.map(({ log: _, ...test }) => test) }
                  : undefined,
              summary,
              polling,
              tests: run.changes(sent?.version ?? -1),
            })
            if (sent) send(update())
            else {
              // everything: serialized once per version, however many clients open it
              const key = `${version}/${planVersion}/${rest}`
              if (run.full?.key !== key) run.full = { key, json: new Serialized(JSON.stringify(update())) }
              send(run.full.json)
            }
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
