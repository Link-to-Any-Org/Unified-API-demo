import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Allow HMR/dev assets to load when the app is accessed through the
  // ngrok tunnel instead of localhost, otherwise client-side hydration
  // (and all interactivity) silently fails in dev mode.
  allowedDevOrigins: ["shamika-unspurious-salably.ngrok-free.dev"],
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
