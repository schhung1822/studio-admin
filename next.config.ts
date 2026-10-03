import type { NextConfig } from "next";

// The Windows app bundles a self-contained server (.next/standalone); the web build
// (Vercel) keeps the default output. See desktop/scripts/build-web.mjs.
const isDesktopBuild = process.env.STUDIO_DESKTOP === "1";

const nextConfig: NextConfig = {
  ...(isDesktopBuild ? { output: "standalone", outputFileTracingRoot: __dirname } : {}),
};

export default nextConfig;
