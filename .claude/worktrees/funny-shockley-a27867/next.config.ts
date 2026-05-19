import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  serverExternalPackages: ["better-sqlite3"],
  images: {
    unoptimized: true
  }
};

export default nextConfig;
