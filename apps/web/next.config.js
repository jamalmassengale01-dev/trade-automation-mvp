/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production';

const apiBase =
  process.env.NEXT_PUBLIC_API_URL ||
  (isDev ? 'http://localhost:3001' : (() => {
    throw new Error('NEXT_PUBLIC_API_URL environment variable is required in production');
  })());

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/api/:path*',     destination: `${apiBase}/api/:path*` },
      { source: '/webhook/:path*', destination: `${apiBase}/webhook/:path*` },
    ];
  },
};

module.exports = nextConfig;
