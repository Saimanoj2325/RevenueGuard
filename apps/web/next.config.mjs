/** @type {import('next').NextConfig} */
const isStatic = process.env.BUILD_STATIC === '1';
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig = {
  reactStrictMode: true,
  // Static demo build (mock backend, no server) → apps/web/out ; normal build → standalone server for Docker
  output: isStatic ? 'export' : 'standalone',
  trailingSlash: isStatic,
  basePath: basePath || undefined,
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_MOCK: process.env.NEXT_PUBLIC_MOCK ?? 'false',
  },
  ...(isStatic ? {} : {
    async rewrites() {
      const backend = process.env.INTERNAL_API_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : 'http://api:8000');
      return [
        {
          source: '/api-backend/:path*',
          destination: `${backend}/:path*`,
        },
      ];
    },
  }),
};

export default nextConfig;
