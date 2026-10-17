import { api } from "@/lib/api"
import { store } from "@/lib/store"

/** The ids of the run's failed tests, in plan order. */
export const GET = api(async (_, ctx: RouteContext<"/api/projects/[project]/runs/[source]/[run]/failed">) => {
  const { project, source, run: name } = await ctx.params
  const run = store().run(project, source, name)
  if (!run) return Response.json({ error: "no such run" }, { status: 404 })
  if (!run.plan) await run.sync()
  return Response.json(
    run.plan?.tests.filter((test) => run.state(test.id).status === "failed").map((test) => test.id) ?? [],
  )
})
