/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // planner.ts uses dynamic import() for highs.ts and loot-data.ts as
      // server-only fallbacks. On the client these are never called (the
      // injected solverFn / lootData are used instead), but webpack still
      // resolves them. Stub out the Node.js built-ins they depend on.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        module: false,
        zlib: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
