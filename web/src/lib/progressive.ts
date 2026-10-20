"use client"

import { useEffect, useRef, useState } from "react"

/** How many of `total` items to render: a screenful first, then more as the `sentinel` after them comes near. */
export function useProgressive(total: number, step = 60) {
  const [count, setCount] = useState(step)
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = sentinel.current
    if (!element || count >= total) return
    // observing again after each step: it fires right away if the sentinel is still near
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setCount(count + step), {
      rootMargin: "1000px",
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [count, total, step])
  return { count, sentinel }
}
