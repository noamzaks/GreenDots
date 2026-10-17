"use client"

import dynamic from "next/dynamic"

// The UI is a single-page app: routing happens in the browser, the server only answers /api requests.
const App = dynamic(() => import("@/views/App"), { ssr: false })

export default function Page() {
  return <App />
}
