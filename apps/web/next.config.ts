import type { NextConfig } from "next";

const allowedDevOrigins: string[] = [];
if (process.env.PUBLIC_APP_URL) {
  try {
    allowedDevOrigins.push(new URL(process.env.PUBLIC_APP_URL).hostname);
  } catch {
    // API configuration validation reports an invalid PUBLIC_APP_URL.
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: [...new Set(allowedDevOrigins)],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000"}/api/:path*` }];
  }
};

export default nextConfig;
