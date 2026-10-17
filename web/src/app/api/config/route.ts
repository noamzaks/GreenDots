import { api } from "@/lib/api"
import { Config } from "@/lib/config"
import { configPath } from "@/lib/settings"
import { store } from "@/lib/store"

export const GET = api(async () => Response.json({ config: store().config, path: configPath() }))

export const PUT = api(async (request) => {
  const parsed = Config.safeParse(await request.json())
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 })
  store().update(() => parsed.data)
  return Response.json({ config: store().config, path: configPath() })
})
