import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  
  // Output configuration for better deployment
  output: 'standalone',
  
  // Monorepo configuration for Vercel
  outputFileTracingRoot: require('path').join(__dirname, '../../'),
};

export default nextConfig;

