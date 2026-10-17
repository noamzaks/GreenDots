import type { NextRequest } from "next/server"
import { api, eventStream, watch } from "@/lib/api"
import { store } from "@/lib/store"
import type { ProjectRuns } from "@/lib/types"

const SUMMARIZED_RUNS = 30

/** A project's runs (the latest summarized), streamed as they change. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/projects/[project]">) {
  const { project } = await ctx.params
  return eventStream(request, async (send, signal) => {
    const unview = store().view(project)
    try {
      await watch(signal, send, (): ProjectRuns => {
        const { config, projectTitle, runInfos } = store()
        const { runs, loading } = runInfos(project, SUMMARIZED_RUNS, true)
        const [synced, pinned] = [config.synced.includes(project), config.pinned.includes(project)]
        return { name: project, title: projectTitle(project), synced, pinned, runs, loading }
      })
    } finally {
      unview()
    }
  })
}

export const PUT = api(async (request, ctx: RouteContext<"/api/projects/[project]">) => {
  const { project } = await ctx.params
  const { synced, pinned } = await request.json()
  store().setProject(project, { synced, pinned })
  return new Response(null, { status: 204 })
})
