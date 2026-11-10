import type { NextConfig } from "next";

// Dev origins beyond localhost allowed to load Next's dev resources (HMR,
// dev chunks). Without this, Next 16 blocks them when the app is opened
// through a tunnel, and the page never hydrates - buttons render but do
// nothing. The OAuth return URL's host is always the public address the app
// is used through, so it's allowed automatically; DEV_TUNNEL_ORIGIN can add
// another host. Next matches entries against the request's hostname only and
// wants them written without a port, so this takes `hostname`, not `host`.
function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const devOrigins = [
  process.env.DEV_TUNNEL_ORIGIN,
  hostnameOf(process.env.LINKTOANY_RETURN_URL),
].filter((origin): origin is string => Boolean(origin));

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: devOrigins.length > 0 ? [...new Set(devOrigins)] : undefined,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // Pin the workspace root to this project. Without it, a stray lockfile
    // in a parent directory (e.g. ~/package-lock.json) makes Next guess the
    // wrong root and warn on every start.
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
