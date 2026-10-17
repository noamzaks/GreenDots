import { api } from "@/lib/api"
import { store } from "@/lib/store"

/** Checks a run that isn't checked anymore (it had no changes for a while), and resumes checking it. */
export const POST = api(async (_, ctx: RouteContext<"/api/projects/[project]/runs/[source]/[run]/check">) => {
  const { project, source, run: name } = await ctx.params
  const run = store().run(project, source, name)
  if (!run) return Response.json({ error: "no such run" }, { status: 404 })
  await store().check(run)
  return new Response(null, { status: 204 })
})
