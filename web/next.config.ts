import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactCompiler: true,
  output: "standalone",
  compress: false, // so event streams reach browsers right away
  experimental: { optimizePackageImports: ["@mantine/core", "@mantine/hooks", "@tabler/icons-react"] },
}

export default nextConfig
