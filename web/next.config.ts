import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactCompiler: true,
  output: "standalone", // only the files the server uses
  images: { unoptimized: true }, // no next/image: leave sharp's native libraries (37 MB) out
  outputFileTracingExcludes: { "*": ["node_modules/sharp/**", "node_modules/@img/**"] },
  compress: false, // so event streams reach browsers right away
  experimental: { optimizePackageImports: ["@mantine/core", "@mantine/hooks", "@tabler/icons-react"] },
}

export default nextConfig
