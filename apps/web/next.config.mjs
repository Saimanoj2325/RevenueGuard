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
};

export default nextConfig;
