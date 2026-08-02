import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: "/rosh-berosh",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
