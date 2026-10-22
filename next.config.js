const { execSync } = require('child_process');

// The deployed commit (lib/app-build.ts), baked into the page and the API
// alike so an old tab can tell a newer deploy is live.
function appBuild() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_APP_BUILD: process.env.NEXT_PUBLIC_APP_BUILD || appBuild(),
  },
  // hensin.space/workout is the yumworkout PWA, a separate Fly app served
  // under the /workout/ base path (https://github.com/yumbrad/yumworkout).
  async rewrites() {
    return [
      { source: '/workout', destination: 'https://yumworkout.fly.dev/workout/' },
      { source: '/workout/:path*', destination: 'https://yumworkout.fly.dev/workout/:path*' },
    ];
  },
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
