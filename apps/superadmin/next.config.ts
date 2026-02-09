import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@kloqo/shared-core', '@kloqo/shared-types', '@kloqo/shared-ui', '@kloqo/shared-firebase'],
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;

