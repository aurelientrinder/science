import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Silence the Turbopack vs Webpack warning */
  turbopack: {},
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
