import type { NextConfig } from "next";

// Local dev origins (e.g. an HTTPS tunnel) beyond localhost, for HMR/dev
// asset loading. Unset by default - set DEV_TUNNEL_ORIGIN to your own
// tunnel hostname (e.g. from `npx ngrok http 3000`) when you need one.
const devTunnelOrigin = process.env.DEV_TUNNEL_ORIGIN;

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: devTunnelOrigin ? [devTunnelOrigin] : undefined,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
