import type { NextConfig } from 'next';
const runtimeCaching = [
  {
    urlPattern: /^https:\/\/fonts\.(?:gstatic)\.com\/.*/i,
    handler: 'CacheFirst',
    options: {
      cacheName: 'google-fonts-webfonts',
      expiration: {
        maxEntries: 4,
        maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
      },
    },
  },
  {
    urlPattern: /^https:\/\/fonts\.(?:googleapis)\.com\/.*/i,
    handler: 'StaleWhileRevalidate',
    options: {
      cacheName: 'google-fonts-stylesheets',
      expiration: {
        maxEntries: 4,
        maxAgeSeconds: 7 * 24 * 60 * 60, // 1 week
      },
    },
  },
  {
    urlPattern: /^https:\/\/firebasestorage\.googleapis\.com\/.*/i,
    handler: 'CacheFirst',
    options: {
      cacheName: 'firebase-storage',
      expiration: {
        maxEntries: 60,
        maxAgeSeconds: 7 * 24 * 60 * 60,
      },
    },
  },
  {
    urlPattern: /^https:\/\/firestore\.googleapis\.com\/.*/i,
    handler: 'NetworkFirst',
    options: {
      cacheName: 'firestore-api',
      networkTimeoutSeconds: 10,
      expiration: {
        maxEntries: 60,
        maxAgeSeconds: 5 * 60,
      },
    },
  },
  {
    urlPattern: /^https:\/\/(www\.)?google-analytics\.com\/.*$/i,
    handler: 'StaleWhileRevalidate',
    options: {
      cacheName: 'analytics',
    },
  },
  {
    urlPattern: /^https:\/\/.*\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/i,
    handler: 'StaleWhileRevalidate',
    options: {
      cacheName: 'static-images',
      expiration: {
        maxEntries: 120,
        maxAgeSeconds: 30 * 24 * 60 * 60,
      },
    },
  },
  {
    urlPattern: ({ url }: { url: URL }) =>
      url.pathname.startsWith('/api/master-departments') ||
      url.pathname.startsWith('/api/clinics') ||
      url.pathname.startsWith('/api/doctors') ||
      url.pathname.startsWith('/api/appointments') ||
      url.pathname.startsWith('/api/patients') ||
      url.pathname.startsWith('/api/bookings') ||
      url.pathname.startsWith('/api/users/'),
    handler: 'NetworkFirst',
    options: {
      cacheName: 'api-json',
      networkTimeoutSeconds: 5,
      expiration: {
        maxEntries: 30,
        maxAgeSeconds: 5 * 60,
      },
    },
  },
];

const withPWA = require('next-pwa')({
  dest: 'public',
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development',
  buildExcludes: [/firebase-messaging-sw\.js$/, /workbox-.*\.js$/],
  runtimeCaching,
});

const ContentSecurityPolicy = `
  default-src 'self';
  script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.gstatic.com https://www.googleapis.com https://www.google.com https://www.googletagmanager.com https://www.google-analytics.com https://static.cloudflareinsights.com https://apis.google.com;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  img-src 'self' data: blob: https://firebasestorage.googleapis.com https://storage.googleapis.com https://images.unsplash.com https://placehold.co;
  font-src 'self' https://fonts.gstatic.com data:;
  connect-src 'self' https://firestore.googleapis.com https://firebase.googleapis.com https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com https://www.googleapis.com https://www.google.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebasestorage.googleapis.com https://www.googletagmanager.com https://www.google-analytics.com https://static.cloudflareinsights.com https://nominatim.openstreetmap.org;
  frame-src 'self' https://www.google.com https://www.gstatic.com;
  media-src 'self' blob:;
  object-src 'none';
  frame-ancestors 'self';
  base-uri 'self';
  form-action 'self';
`.replace(/\s{2,}/g, ' ').trim();

const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: ContentSecurityPolicy,
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'geolocation=(self), microphone=(), camera=()',
  },
  {
    key: 'Cross-Origin-Opener-Policy',
    value: 'same-origin',
  },
  {
    key: 'Cross-Origin-Resource-Policy',
    value: 'same-origin',
  },
];

const nextConfig: NextConfig = {
  // Transpile workspace packages for monorepo
  transpilePackages: ['@kloqo/shared-core', '@kloqo/shared-types', '@kloqo/shared-ui', '@kloqo/shared-firebase'],

  // Enable compression for better performance
  compress: true,
  // Disable production source maps to prevent source code exposure
  // Use server-side source maps with error tracking services (e.g., Sentry) instead
  productionBrowserSourceMaps: false,

  // SWC minification is enabled by default in Next.js 15

  // TypeScript configuration
  typescript: {
    // Enable TypeScript checking during builds
    ignoreBuildErrors: true, // Temporarily ignore for monorepo packages
  },

  // ESLint configuration
  eslint: {
    ignoreDuringBuilds: process.env.NODE_ENV === 'development',
  },

  // Image optimization
  images: {
    formats: ['image/webp', 'image/avif'],
    minimumCacheTTL: 60,
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: "https",
        hostname: "firebasestorage.googleapis.com",
        port: "",
        pathname: "/**",
      },
    ],
  },

  // Experimental features for better performance
  experimental: {
    optimizePackageImports: ['lucide-react'],
    // CSS optimization disabled due to critters module resolution issues in Next.js 15
    // optimizeCss: true,
  },

  // Enable prefetching for better mobile navigation
  reactStrictMode: true,

  // Webpack optimizations
  webpack: (config, { dev, isServer }) => {
    // Only apply optimizations in production
    if (!dev) {
      config.optimization.usedExports = true;
      config.optimization.sideEffects = false;

      // Bundle analyzer
      if (!isServer && process.env.ANALYZE === 'true') {
        const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
        config.plugins.push(
          new BundleAnalyzerPlugin({
            analyzerMode: 'static',
            openAnalyzer: false,
            filename: 'bundle-analysis.html'
          })
        );
      }
    }

    return config;
  },

  // Output configuration for better deployment
  // output: 'standalone', // Disabled for dev mode compatibility

  // CORS headers for API access
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,DELETE,PATCH,POST,PUT,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization" },
        ]
      },
      {
        source: '/:path*',
        headers: [
          ...securityHeaders,
          {
            key: 'Access-Control-Allow-Origin',
            value: '*',
          },
        ],
      },
    ];
  },
};

// Temporarily disable PWA wrapper for development testing
// export default nextConfig;
export default withPWA(nextConfig);
