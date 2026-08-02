import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  basePath: "/rosh-berosh",
  assetPrefix: "/rosh-berosh/",
};

export default nextConfig;
