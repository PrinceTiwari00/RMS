import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }, { source: "/api/:path*", headers: [
      { key: "Cache-Control", value: "private, no-store" },
    ] }];
  },
  output: "standalone",
  // The Arena live preview proxies this app under https://{port}-{sandboxId}.e2b.app.
  // Dev-server cross-origin checks must accept that host as well as localhost.
  allowedDevOrigins: ["*.e2b.app", "localhost", "127.0.0.1"],
  eslint: { ignoreDuringBuilds: true },
  // node:sqlite is loaded only from server code; keep native/server packages
  // out of browser bundles using Next 15's top-level configuration key.
  serverExternalPackages: [],
};

export default nextConfig;
