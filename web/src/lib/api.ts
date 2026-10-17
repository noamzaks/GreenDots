import type { NextRequest } from "next/server"
import { store } from "./store"

const PING = 25_000 // keeps idle streams (and proxies in between) alive

/** Wraps a route handler: errors become JSON, and the request is recorded on the activity page. */
export function api<Context>(handler: (request: NextRequest, context: Context) => Promise<Response>) {
  return async (request: NextRequest, context: Context) => {
    const start = performance.now()
    const response = await handler(request, context).catch((error) =>
      Response.json({ error: String(error?.message ?? error) }, { status: 500 }),
    )
    const { pathname, search } = request.nextUrl
    const detail = `${request.method} ${response.status}`
    store().activity.add({
      kind: "api",
      path: decodeURIComponent(pathname + search),
      detail,
      ms: performance.now() - start,
    })
    return response
  }
}

type Send = (data: unknown) => void

/** A server-sent event stream: `produce` sends messages until the client goes away (`signal`). */
export function eventStream(request: NextRequest, produce: (send: Send, signal: AbortSignal) => Promise<void>) {
  const { activity } = store()
  const path = decodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)
  const opened = performance.now()
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      const write = (text: string) => {
        if (!request.signal.aborted) controller.enqueue(encoder.encode(text))
      }
      activity.add({ kind: "api", path, detail: "stream opened" })
      const ping = setInterval(() => write(": ping\n\n"), PING)
      try {
        await produce((data) => write(`data: ${JSON.stringify(data)}\n\n`), request.signal)
      } catch (error) {
        if (!request.signal.aborted)
          write(`data: ${JSON.stringify({ error: String((error as Error)?.message ?? error) })}\n\n`)
      }
      clearInterval(ping)
      activity.add({ kind: "api", path, detail: "stream closed", ms: performance.now() - opened })
      try {
        controller.close()
      } catch {}
    },
  })
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  })
}

/** Sends `compute()` whenever it differs from what was sent last, until the client goes away. */
export async function watch(signal: AbortSignal, send: Send, compute: () => unknown) {
  let last = ""
  while (!signal.aborted) {
    const value = compute()
    const json = JSON.stringify(value)
    if (json !== last) send(value)
    last = json
    await store().changed.wait(PING, signal)
  }
}

export const number = (request: NextRequest, key: string) => {
  const value = request.nextUrl.searchParams.get(key)
  return value === null || value === "" ? undefined : Number(value)
}

type RunParams = Promise<{ project: string; source: string; run: string }>

/** The run and log a log request is about: `?test=<id>` or `?session=<worker>`. */
export async function findLog(request: NextRequest, params: RunParams) {
  const { project, source, run: name } = await params
  const run = store().run(project, source, name)
  const session = number(request, "session")
  const test = request.nextUrl.searchParams.get("test") ?? ""
  const path = run && (await store().logFile(run, session !== undefined ? { session } : { test }))
  return run && path ? { run, path, state: () => (session === undefined ? run.state(test) : undefined) } : undefined
}
