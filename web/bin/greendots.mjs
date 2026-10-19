#!/usr/bin/env node
// Starts the GreenDots server (the standalone build) on the host and port from its config file (see
// src/lib/settings.ts).
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const app = join(dirname(fileURLToPath(import.meta.url)), "..", ".next", "standalone")
if (!existsSync(join(app, "server.js"))) {
  console.error(`No build in ${app}: run \`bun run build\` first.`)
  process.exit(1)
}
const path = resolve(
  process.env.GREENDOTS_CONFIG ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "greendots", "config.json"),
)
let server = {}
try {
  server = JSON.parse(readFileSync(path, "utf8")).server ?? {}
} catch {}
const env = {
  ...process.env,
  GREENDOTS_CONFIG: path, // the server runs in its own directory
  HOSTNAME: server.host ?? "127.0.0.1",
  PORT: String(server.port ?? 3000),
  // filesystem calls run on libuv's thread pool: a slow share must not take all of its (default 4) threads
  UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? "64",
}
spawn(process.execPath, [join(app, "server.js")], { cwd: app, env, stdio: "inherit" }).on("exit", (code) =>
  process.exit(code ?? 0),
)
