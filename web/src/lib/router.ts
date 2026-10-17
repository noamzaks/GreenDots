"use client"

import { useParams as useRouteParams, useSearchParams } from "wouter"

/** A route param, decoded (wouter only decodes what `decodeURI` does). */
export function useParam(name: string): string {
  const value = (useRouteParams() as Record<string, string | undefined>)[name] ?? ""
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** A query parameter, kept in the URL (replacing the history entry, like a filter field should). */
export function useQueryParam(name: string): [string | null, (value: string | null) => void] {
  const [params, setParams] = useSearchParams()
  const set = (value: string | null) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (value === null || value === "") next.delete(name)
        else next.set(name, value)
        return next
      },
      { replace: true },
    )
  return [params.get(name), set]
}

/** The run a page is about, from its route. */
export function useRunRef() {
  return { project: useParam("project"), source: useParam("source"), run: useParam("run") }
}
