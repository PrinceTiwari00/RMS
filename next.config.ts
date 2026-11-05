import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The Arena live preview proxies this app under https://{port}-{sandboxId}.e2b.app.
  // Dev-server cross-origin checks must accept that host as well as localhost.
  allowedDevOrigins: ["*.e2b.app", "localhost", "127.0.0.1"],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // node:sqlite is loaded only from server code; keep it out of the client bundle.
    serverComponentsExternalPackages: [],
  },
};

export default nextConfig;
