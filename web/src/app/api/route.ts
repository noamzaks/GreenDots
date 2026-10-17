import { version } from "../../../package.json"

const DOCS = `GreenDots ${version} API. Streams are server-sent events (text/event-stream): the current state
first, then updates as they happen. Runs are addressed as /api/projects/<project>/runs/<source>/<run>.

GET  /api/config                              the settings, and the path of the file they're saved in
PUT  /api/config                              replaces the settings
GET  /api/projects                            stream: every project in every source, with its latest runs
GET  /api/projects/<project>                  stream: a project's runs, the latest summarized
PUT  /api/projects/<project>                  {"synced": bool}
GET  <run>                                    stream: the plan, a summary, the tests' states; then changes
POST <run>/check                              checks a run that isn't checked anymore, and resumes checking it
GET  <run>/failed                             the ids of the failed tests
GET  <run>/log?test=<id> (or ?session=<worker>, for output outside of tests)
                                              stream: the end of the log, then lines as they're written
GET  <run>/log/lines?test=...&before=<offset>&bytes=<n>
                                              lines ending at a line start (default: the end of the log)
GET  <run>/log/line?test=...&offset=<offset>&from=<offset>[&download]
                                              a piece of a long line (or, with download, all of it)
GET  /api/activity                            stream: filesystem operations, syncs and requests
`

export function GET() {
  return new Response(DOCS, { headers: { "content-type": "text/plain" } })
}
