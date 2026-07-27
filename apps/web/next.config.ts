import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["10.2.156.137"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000"}/api/:path*` }];
  }
};

export default nextConfig;
