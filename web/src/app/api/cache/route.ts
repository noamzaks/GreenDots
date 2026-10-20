import { api } from "@/lib/api"
import { store } from "@/lib/store"

const usage = async () => Response.json({ dir: store().disk.dir, bytes: await store().disk.usage() })

export const GET = api(usage)

export const DELETE = api(async () => {
  await store().clearCache()
  return usage()
})
