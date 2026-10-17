import dayjs from "dayjs"
import duration from "dayjs/plugin/duration"
import relativeTime from "dayjs/plugin/relativeTime"

dayjs.extend(relativeTime)
dayjs.extend(duration)

export const ago = (seconds?: number) => (seconds ? dayjs.unix(seconds).fromNow() : "")
export function took(from?: number, to?: number) {
  if (!from || !to) return ""
  const seconds = to - from
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  return dayjs.duration(seconds, "seconds").format(seconds >= 3600 ? "H[h] m[m]" : "m[m] s[s]")
}
export const clock = (seconds: number) => dayjs.unix(seconds).format("HH:mm:ss.SSS")
